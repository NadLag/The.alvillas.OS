BEGIN;

-- Settlements reuse the immutable journal and its attributed immutable audit receipt.
CREATE FUNCTION app_employee_settlement_lock() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE source employee_compensation_submission%ROWTYPE;
BEGIN
 IF NEW.bucket IS DISTINCT FROM 'EMPLOYEE_PAYMENT' AND NEW.bucket IS DISTINCT FROM 'COMPENSATION_OFFSET'
  AND NEW.dimensions->>'source' IS DISTINCT FROM 'EMPLOYEE_PAYMENT' AND NEW.dimensions->>'source' IS DISTINCT FROM 'EMPLOYEE_COMPENSATION_OFFSET' THEN RETURN NEW;END IF;
 SELECT s.* INTO source FROM employee_compensation_claim c JOIN employee_compensation_submission s ON s.organization_id=c.organization_id AND s.id=c.submission_id
  WHERE c.organization_id=NEW.organization_id AND c.id=(NEW.dimensions->>'employee_compensation_claim_id')::uuid;
 IF source.id IS NULL THEN RAISE EXCEPTION 'employee settlement requires its actual beneficiary claim';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(NEW.organization_id::text||':employee-compensation-run:'||source.run_id::text,0));
 PERFORM pg_advisory_xact_lock(hashtextextended(NEW.organization_id::text||':employee-submission:'||source.id::text,0));RETURN NEW;
END $$;
CREATE TRIGGER employee_settlement_lock BEFORE INSERT ON posting FOR EACH ROW EXECUTE FUNCTION app_employee_settlement_lock();

CREATE FUNCTION app_assert_employee_settlement(org_uuid uuid,journal_uuid uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE t financial_transaction%ROWTYPE; original financial_transaction%ROWTYPE; a audit_log%ROWTYPE;
 c employee_compensation_claim%ROWTYPE; s employee_compensation_submission%ROWTYPE; r employee_compensation_recognition%ROWTYPE;
 funding ledger_account%ROWTYPE; period accounting_period%ROWTYPE; decision accounting_period_event%ROWTYPE;
 intent jsonb; expected_dimensions jsonb; value numeric; earned numeric; balance numeric; paid_at timestamptz; point timestamptz; kind text; wallet_person uuid; target_bucket text;
BEGIN
 SELECT * INTO t FROM financial_transaction WHERE organization_id=org_uuid AND id=journal_uuid;
 IF t.id IS NULL THEN RAISE EXCEPTION 'employee settlement requires its actual journal';END IF;
 IF t.reverses_transaction_id IS NOT NULL THEN
  SELECT * INTO original FROM financial_transaction WHERE organization_id=org_uuid AND id=t.reverses_transaction_id;
  SELECT * INTO a FROM audit_log WHERE organization_id=org_uuid AND resource_type='financial_transaction' AND resource_id=original.id AND action='finance.employee_settlement.posted';
  IF original.id IS NULL OR a.id IS NULL OR original.reverses_transaction_id IS NOT NULL
   OR t.reference IS DISTINCT FROM original.reference||':VOID' OR t.idempotency_key IS DISTINCT FROM original.idempotency_key||':void'
   OR NOT EXISTS(SELECT 1 FROM audit_log x WHERE x.organization_id=org_uuid AND x.resource_type='financial_transaction' AND x.resource_id=original.id
    AND x.action='finance.employee_settlement.reversed' AND x.actor_id=t.created_by AND x.reason=t.description
    AND x.after->>'submissionId'=a.after#>>'{input,id}' AND x.after->>'claimId'=a.after#>>'{input,claimId}'
    AND x.after->'originalTransactionIds'=jsonb_build_array(original.id::text) AND x.after->'reversalTransactionIds'=jsonb_build_array(t.id::text))
  THEN RAISE EXCEPTION 'employee settlement reversal requires its exact original and attributed atomic receipt';END IF;
  -- The shared ledger guard enforces an exact opposite of every original posting.
 ELSE
  SELECT * INTO a FROM audit_log WHERE organization_id=org_uuid AND resource_type='financial_transaction' AND resource_id=t.id AND action='finance.employee_settlement.posted';
  IF a.id IS NULL OR (SELECT count(*) FROM audit_log WHERE organization_id=org_uuid AND resource_type='financial_transaction' AND resource_id=t.id AND action='finance.employee_settlement.posted')<>1
   OR a.actor_id IS DISTINCT FROM t.created_by OR a.reason IS DISTINCT FROM t.description
   OR a.after->>'transactionId' IS DISTINCT FROM t.id::text OR (a.after->>'postedAt')::timestamptz IS DISTINCT FROM t.occurred_at
  THEN RAISE EXCEPTION 'employee settlement requires one attributed atomic receipt';END IF;
 END IF;
 intent=a.after->'input';
 IF jsonb_typeof(intent) IS DISTINCT FROM 'object' OR (SELECT count(*) FROM jsonb_object_keys(intent))<>11
  OR NOT(intent ?& ARRAY['id','claimId','kind','fundingAccountId','idempotencyKey','amount','currency','paidAt','reference','currentPeriod','reason'])
  OR jsonb_typeof(intent->'currentPeriod') IS DISTINCT FROM 'boolean' OR jsonb_typeof(intent->'amount') IS DISTINCT FROM 'string'
  OR intent->>'kind' NOT IN ('PAYMENT','WALLET_OFFSET') OR intent->>'idempotencyKey' IS DISTINCT FROM ((intent->>'idempotencyKey')::uuid)::text
  OR jsonb_typeof(a.after) IS DISTINCT FROM 'object' OR (SELECT count(*) FROM jsonb_object_keys(a.after))<>6
 THEN RAISE EXCEPTION 'employee settlement requires its complete canonical intent';END IF;
 value=(intent->>'amount')::numeric;paid_at=(intent->>'paidAt')::timestamptz;point=clock_timestamp();kind=intent->>'kind';
 SELECT * INTO c FROM employee_compensation_claim WHERE organization_id=org_uuid AND id=(intent->>'claimId')::uuid;
 SELECT * INTO s FROM employee_compensation_submission WHERE organization_id=org_uuid AND id=c.submission_id;
 SELECT * INTO r FROM employee_compensation_recognition WHERE organization_id=org_uuid AND claim_id=c.id;
 SELECT sum(amount) INTO earned FROM employee_compensation_cost WHERE organization_id=org_uuid AND claim_id=c.id;
 IF c.id IS NULL OR s.id IS NULL OR r.id IS NULL OR r.submission_id<>s.id OR r.id::text IS DISTINCT FROM a.after->>'recognitionId'
  OR s.id::text IS DISTINCT FROM intent->>'id' OR value<=0 OR value>earned
  OR (intent->>'amount') !~ '^(0|[1-9][0-9]{0,15})(\.[0-9]{1,2})?$' OR length(btrim(intent->>'reason')) NOT BETWEEN 6 AND 500
  OR intent->>'reason' IS DISTINCT FROM a.reason OR paid_at>point
  OR EXISTS(SELECT 1 FROM employee_compensation_cost cost WHERE cost.organization_id=org_uuid AND cost.claim_id=c.id AND cost.currency IS DISTINCT FROM intent->>'currency')
  OR (SELECT count(*) FROM employee_compensation_recognition_line l JOIN employee_compensation_cost cost ON cost.organization_id=l.organization_id AND cost.id=l.cost_id
   WHERE l.organization_id=org_uuid AND l.recognition_id=r.id AND cost.claim_id=c.id)<>(SELECT count(*) FROM employee_compensation_cost WHERE organization_id=org_uuid AND claim_id=c.id)
 THEN RAISE EXCEPTION 'employee settlement retains the complete actual earned beneficiary claim';END IF;
 IF t.reverses_transaction_id IS NULL THEN
  IF EXISTS(SELECT 1 FROM employee_compensation_withdrawal WHERE organization_id=org_uuid AND submission_id=s.id)
   OR EXISTS(SELECT 1 FROM employee_compensation_run_cancellation WHERE organization_id=org_uuid AND run_id=s.run_id)
   OR EXISTS(SELECT 1 FROM employee_compensation_recognition_line l JOIN financial_transaction v ON v.organization_id=l.organization_id AND v.reverses_transaction_id=l.transaction_id WHERE l.organization_id=org_uuid AND l.recognition_id=r.id)
   OR t.reference IS DISTINCT FROM 'EMPLOYEE-SETTLEMENT:'||(intent->>'idempotencyKey') OR t.idempotency_key IS DISTINCT FROM 'employee-settlement:'||(intent->>'idempotencyKey')
   OR length(COALESCE(intent->>'reference',''))>160 OR NOT EXISTS(SELECT 1 FROM currency WHERE code=intent->>'currency' AND value=round(value,minor_unit))
  THEN RAISE EXCEPTION 'employee settlement requires an active recognized source and canonical identity';END IF;
  SELECT * INTO funding FROM ledger_account WHERE organization_id=org_uuid AND id=(intent->>'fundingAccountId')::uuid;
  IF funding.id IS NULL OR funding.archived_at IS NOT NULL OR funding.normal_side<>'DEBIT' OR funding.code LIKE 'CASH\_CUSTODY\_%' ESCAPE '\'
   OR NOT(funding.account_type IN ('ASSET','ASSET_LOCATION') OR(funding.account_type='STAFF_WALLET' AND EXISTS(
    SELECT 1 FROM team_wallet w JOIN person p ON p.organization_id=w.organization_id AND p.id=w.person_id WHERE w.organization_id=org_uuid AND w.ledger_account_id=funding.id AND p.archived_at IS NULL)))
  THEN RAISE EXCEPTION 'employee settlement requires its available physical source';END IF;
  IF kind='WALLET_OFFSET' THEN
   SELECT person_id INTO wallet_person FROM team_wallet WHERE organization_id=org_uuid AND ledger_account_id=funding.id;
   IF funding.account_type<>'STAFF_WALLET' OR wallet_person IS DISTINCT FROM c.person_id THEN RAISE EXCEPTION 'employee offset requires the actual beneficiary wallet';END IF;
   PERFORM id FROM person WHERE organization_id=org_uuid AND id=wallet_person FOR UPDATE;
   SELECT COALESCE(sum(CASE WHEN side='DEBIT' THEN amount ELSE -amount END),0) INTO balance FROM posting WHERE organization_id=org_uuid AND ledger_account_id=funding.id AND currency=intent->>'currency';
   IF balance<0 THEN RAISE EXCEPTION 'employee offset cannot exceed the actual derived wallet balance';END IF;
  END IF;
  target_bucket=CASE WHEN kind='WALLET_OFFSET' THEN 'COMPENSATION_OFFSET' ELSE 'EMPLOYEE_PAYMENT' END;
  expected_dimensions=jsonb_build_object('employee_person_id',c.person_id::text,'employee_compensation_claim_id',c.id::text,'source',CASE WHEN kind='WALLET_OFFSET' THEN 'EMPLOYEE_COMPENSATION_OFFSET' ELSE 'EMPLOYEE_PAYMENT' END);
  IF kind='WALLET_OFFSET' THEN expected_dimensions=expected_dimensions||jsonb_build_object('employee_compensation_offset_id',intent->>'idempotencyKey','wallet_person_id',c.person_id::text);
  ELSE expected_dimensions=expected_dimensions||jsonb_build_object('employee_compensation_payment_id',intent->>'idempotencyKey');END IF;
  IF (SELECT count(*) FROM posting WHERE organization_id=org_uuid AND transaction_id=t.id)<>2
   OR EXISTS(SELECT 1 FROM posting WHERE organization_id=org_uuid AND transaction_id=t.id AND(amount<>value OR currency IS DISTINCT FROM intent->>'currency' OR bucket IS DISTINCT FROM target_bucket OR dimensions IS DISTINCT FROM expected_dimensions))
   OR (SELECT count(*) FROM posting p JOIN ledger_account l ON l.organization_id=p.organization_id AND l.id=p.ledger_account_id WHERE p.organization_id=org_uuid AND p.transaction_id=t.id AND p.side='DEBIT' AND l.code='EMPLOYEE_PAYABLE' AND l.account_type='CLAIM_OWNERSHIP' AND l.normal_side='CREDIT')<>1
   OR (SELECT count(*) FROM posting WHERE organization_id=org_uuid AND transaction_id=t.id AND side='CREDIT' AND ledger_account_id=funding.id)<>1
  THEN RAISE EXCEPTION 'employee settlement reduces only its actual liability and funding source';END IF;
  IF (intent->>'currentPeriod')::boolean THEN
   SELECT * INTO period FROM accounting_period WHERE organization_id=org_uuid AND id=(a.after->>'sourcePeriodId')::uuid;
   SELECT * INTO decision FROM accounting_period_event WHERE organization_id=org_uuid AND period_id=period.id ORDER BY version DESC LIMIT 1;
   IF period.id IS NULL OR NOT(period.starts_at<=paid_at AND paid_at<period.ends_at) OR decision.id::text IS DISTINCT FROM a.after->>'sourcePeriodEventId'
    OR (decision.kind='CLOSE' OR(decision.kind='REOPEN' AND decision.reopens_until<=point)) IS DISTINCT FROM true
    OR t.occurred_at<date_trunc('milliseconds',transaction_timestamp()) OR t.occurred_at>point
    OR date_trunc('month',t.occurred_at AT TIME ZONE period.timezone) IS DISTINCT FROM date_trunc('month',point AT TIME ZONE period.timezone)
    OR NOT app_financial_period_is_open(org_uuid,t.occurred_at)
   THEN RAISE EXCEPTION 'employee settlement adjustment retains its actual closed source and current open journal';END IF;
  ELSIF t.occurred_at IS DISTINCT FROM paid_at OR a.after->>'sourcePeriodId' IS NOT NULL OR a.after->>'sourcePeriodEventId' IS NOT NULL THEN RAISE EXCEPTION 'employee settlement retains its actual paid instant';END IF;
 END IF;
 SELECT COALESCE(sum(CASE WHEN p.side='CREDIT' THEN p.amount ELSE -p.amount END),0) INTO balance FROM posting p JOIN ledger_account l ON l.organization_id=p.organization_id AND l.id=p.ledger_account_id
  WHERE p.organization_id=org_uuid AND l.code='EMPLOYEE_PAYABLE' AND l.account_type='CLAIM_OWNERSHIP' AND l.normal_side='CREDIT' AND p.currency=intent->>'currency'
   AND p.dimensions->>'employee_compensation_claim_id'=c.id::text AND p.dimensions->>'employee_person_id'=c.person_id::text;
 IF balance<0 OR balance>earned THEN RAISE EXCEPTION 'employee settlement cannot oversettle or invent earned money';END IF;
END $$;

CREATE OR REPLACE FUNCTION app_employee_recognition_posting_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE link_uuid uuid;
BEGIN
 IF NEW.dimensions->>'source' IN ('EMPLOYEE_PAYMENT','EMPLOYEE_COMPENSATION_OFFSET') OR NEW.bucket IN ('EMPLOYEE_PAYMENT','COMPENSATION_OFFSET') THEN
  PERFORM app_assert_employee_settlement(NEW.organization_id,NEW.transaction_id);RETURN NEW;END IF;
 IF NEW.dimensions->>'source' IS DISTINCT FROM 'EMPLOYEE_COMPENSATION' AND NEW.bucket IS DISTINCT FROM 'EMPLOYEE_COMPENSATION'
  AND NOT COALESCE(NEW.dimensions ? 'employee_compensation_claim_id',false)
  AND NOT EXISTS(SELECT 1 FROM ledger_account a WHERE a.organization_id=NEW.organization_id AND a.id=NEW.ledger_account_id AND a.code='EMPLOYEE_PAYABLE') THEN RETURN NEW;END IF;
 SELECT id INTO link_uuid FROM employee_compensation_recognition_line WHERE organization_id=NEW.organization_id AND transaction_id=NEW.transaction_id AND cost_id::text=NEW.dimensions->>'employee_compensation_cost_id';
 IF link_uuid IS NULL THEN RAISE EXCEPTION 'employee recognition postings require their actual atomic source';END IF;
 PERFORM app_assert_employee_recognition_line(NEW.organization_id,link_uuid);RETURN NEW;
END $$;

CREATE FUNCTION app_employee_settlement_audit_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target financial_transaction%ROWTYPE; journal_uuid uuid;
BEGIN
 IF NEW.action='finance.employee_settlement.posted' THEN journal_uuid=NEW.resource_id;
 ELSIF NEW.action='finance.employee_settlement.reversed' THEN
  IF jsonb_typeof(NEW.after->'reversalTransactionIds') IS DISTINCT FROM 'array' OR jsonb_array_length(NEW.after->'reversalTransactionIds')<>1 THEN RAISE EXCEPTION 'employee reversal requires one exact new journal';END IF;
  journal_uuid=(NEW.after#>>'{reversalTransactionIds,0}')::uuid;
 ELSE RETURN NEW;END IF;
 SELECT * INTO target FROM financial_transaction WHERE organization_id=NEW.organization_id AND id=journal_uuid;
 IF NEW.resource_type IS DISTINCT FROM 'financial_transaction' OR target.id IS NULL OR NOT EXISTS(SELECT 1 FROM financial_transaction t WHERE t.organization_id=NEW.organization_id AND t.id=journal_uuid AND t.xmin::text=pg_current_xact_id()::text) THEN RAISE EXCEPTION 'employee settlement receipt belongs to its actual new journal';END IF;
 PERFORM app_assert_employee_settlement(NEW.organization_id,target.id);RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER employee_settlement_audit_guard AFTER INSERT ON audit_log DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app_employee_settlement_audit_guard();
COMMIT;
