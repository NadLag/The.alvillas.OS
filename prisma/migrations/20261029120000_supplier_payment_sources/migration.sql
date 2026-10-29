BEGIN;

-- Payments reuse the immutable financial journal and its attributed immutable audit receipt.
-- The invoice lock is shared with source recognition, settlements and reversals.
CREATE FUNCTION app_supplier_payment_lock() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE invoice_uuid uuid;
BEGIN
 IF NEW.bucket IS DISTINCT FROM 'SUPPLIER_PAYMENT' AND NEW.dimensions->>'source' IS DISTINCT FROM 'SUPPLIER_PAYMENT' THEN RETURN NEW; END IF;
 invoice_uuid=(NEW.dimensions->>'supplier_invoice_id')::uuid;
 IF invoice_uuid IS NULL THEN RAISE EXCEPTION 'supplier payment requires its actual invoice'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(NEW.organization_id::text||':supplier-invoice:'||invoice_uuid,0));
 RETURN NEW;
END $$;
CREATE TRIGGER supplier_payment_lock BEFORE INSERT ON posting FOR EACH ROW EXECUTE FUNCTION app_supplier_payment_lock();

CREATE FUNCTION app_assert_supplier_payment(org_uuid uuid,journal_uuid uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE t financial_transaction%ROWTYPE; original financial_transaction%ROWTYPE; a audit_log%ROWTYPE;
 i supplier_invoice%ROWTYPE; r supplier_invoice_recognition%ROWTYPE; revision supplier_invoice_revision%ROWTYPE;
 funding ledger_account%ROWTYPE; c accounting_period%ROWTYPE; decision accounting_period_event%ROWTYPE;
 intent jsonb; expected_dimensions jsonb; value numeric; balance numeric; paid_at timestamptz; point timestamptz;
BEGIN
 SELECT * INTO t FROM financial_transaction WHERE organization_id=org_uuid AND id=journal_uuid;
 IF t.id IS NULL THEN RAISE EXCEPTION 'supplier payment requires its actual journal'; END IF;
 IF t.reverses_transaction_id IS NOT NULL THEN
  SELECT * INTO original FROM financial_transaction WHERE organization_id=org_uuid AND id=t.reverses_transaction_id;
  SELECT * INTO a FROM audit_log WHERE organization_id=org_uuid AND resource_type='financial_transaction' AND resource_id=original.id AND action='finance.supplier_payment.posted';
  IF original.id IS NULL OR a.id IS NULL OR original.reverses_transaction_id IS NOT NULL
   OR t.reference IS DISTINCT FROM original.reference||':VOID' OR t.idempotency_key IS DISTINCT FROM original.idempotency_key||':void'
   OR NOT EXISTS(SELECT 1 FROM audit_log x WHERE x.organization_id=org_uuid AND x.resource_type='financial_transaction' AND x.resource_id=original.id
    AND x.action='finance.supplier_payment.reversed' AND x.actor_id=t.created_by AND x.reason=t.description
    AND x.after->>'invoiceId'=a.after#>>'{input,id}'
    AND x.after->'originalTransactionIds'=jsonb_build_array(original.id::text) AND x.after->'reversalTransactionIds'=jsonb_build_array(t.id::text))
  THEN RAISE EXCEPTION 'supplier payment reversal requires its exact original and attributed atomic receipt'; END IF;
  -- The global ledger guard enforces an exact opposite of every original posting.
 ELSE
  SELECT * INTO a FROM audit_log WHERE organization_id=org_uuid AND resource_type='financial_transaction' AND resource_id=t.id AND action='finance.supplier_payment.posted';
  IF a.id IS NULL OR (SELECT count(*) FROM audit_log WHERE organization_id=org_uuid AND resource_type='financial_transaction' AND resource_id=t.id AND action='finance.supplier_payment.posted')<>1
   OR a.actor_id IS DISTINCT FROM t.created_by OR a.reason IS DISTINCT FROM t.description
   OR a.after->>'transactionId' IS DISTINCT FROM t.id::text OR (a.after->>'postedAt')::timestamptz IS DISTINCT FROM t.occurred_at
  THEN RAISE EXCEPTION 'supplier payment requires one attributed atomic receipt'; END IF;
 END IF;
 intent=a.after->'input';
 IF jsonb_typeof(intent) IS DISTINCT FROM 'object' OR (SELECT count(*) FROM jsonb_object_keys(intent))<>10
  OR NOT(intent ?& ARRAY['id','expectedVersion','fundingAccountId','idempotencyKey','amount','currency','paidAt','reference','currentPeriod','reason'])
  OR jsonb_typeof(intent->'currentPeriod') IS DISTINCT FROM 'boolean' OR jsonb_typeof(intent->'amount') IS DISTINCT FROM 'string'
  OR jsonb_typeof(intent->'expectedVersion') IS DISTINCT FROM 'number' OR (intent->>'expectedVersion') !~ '^[1-9][0-9]*$'
  OR intent->>'idempotencyKey' IS DISTINCT FROM ((intent->>'idempotencyKey')::uuid)::text
 THEN RAISE EXCEPTION 'supplier payment requires its complete canonical intent'; END IF;
 value=(intent->>'amount')::numeric; paid_at=(intent->>'paidAt')::timestamptz; point=clock_timestamp();
 SELECT * INTO i FROM supplier_invoice WHERE organization_id=org_uuid AND id=(intent->>'id')::uuid;
 SELECT * INTO r FROM supplier_invoice_recognition WHERE organization_id=org_uuid AND invoice_id=i.id;
 SELECT * INTO revision FROM supplier_invoice_revision WHERE organization_id=org_uuid AND id=i.current_revision_id;
 IF i.id IS NULL OR r.id IS NULL OR revision.id IS NULL OR i.state<>'APPROVED' OR i.archived_at IS NOT NULL
  OR i.version<>(intent->>'expectedVersion')::integer OR r.id::text IS DISTINCT FROM a.after->>'recognitionId'
  OR i.current_submission_id IS DISTINCT FROM r.submission_id OR i.version<>r.invoice_version
  OR intent->>'currency' IS DISTINCT FROM revision.currency OR value<=0 OR value>revision.amount
  OR (intent->>'amount') !~ '^(0|[1-9][0-9]{0,15})(\.[0-9]{1,2})?$' OR length(btrim(intent->>'reason')) NOT BETWEEN 6 AND 500
  OR intent->>'reason' IS DISTINCT FROM a.reason OR paid_at>point
  OR EXISTS(SELECT 1 FROM supplier s WHERE s.organization_id=org_uuid AND s.id=i.supplier_id AND s.archived_at IS NOT NULL)
 THEN RAISE EXCEPTION 'supplier payment retains its actual recognized invoice and exact positive money'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(org_uuid::text||':supplier-invoice:'||i.id,0));
 IF t.reverses_transaction_id IS NULL THEN
  IF EXISTS(SELECT 1 FROM supplier_invoice_recognition_line l JOIN financial_transaction v ON v.organization_id=l.organization_id AND v.reverses_transaction_id=l.transaction_id
    WHERE l.organization_id=org_uuid AND l.recognition_id=r.id)
   OR t.reference IS DISTINCT FROM 'SUPPLIER-PAYMENT:'||(intent->>'idempotencyKey')
   OR t.idempotency_key IS DISTINCT FROM 'supplier-payment:'||(intent->>'idempotencyKey')
   OR length(COALESCE(intent->>'reference',''))>160
   OR NOT EXISTS(SELECT 1 FROM currency WHERE code=revision.currency AND value=round(value,minor_unit))
  THEN RAISE EXCEPTION 'supplier payment requires an active actual claim and canonical payment identity'; END IF;
  SELECT * INTO funding FROM ledger_account WHERE organization_id=org_uuid AND id=(intent->>'fundingAccountId')::uuid;
  IF funding.id IS NULL OR funding.archived_at IS NOT NULL OR funding.normal_side<>'DEBIT' OR funding.code LIKE 'CASH\_CUSTODY\_%' ESCAPE '\'
   OR NOT (funding.account_type IN ('ASSET','ASSET_LOCATION') OR (funding.account_type='STAFF_WALLET' AND EXISTS(
    SELECT 1 FROM team_wallet w JOIN person p ON p.organization_id=w.organization_id AND p.id=w.person_id
     WHERE w.organization_id=org_uuid AND w.ledger_account_id=funding.id AND p.archived_at IS NULL)))
  THEN RAISE EXCEPTION 'supplier payment requires its available physical funding source'; END IF;
  expected_dimensions=jsonb_build_object('supplier_id',i.supplier_id::text,'supplier_invoice_id',i.id::text,'supplier_payment_id',intent->>'idempotencyKey','source','SUPPLIER_PAYMENT');
  IF (SELECT count(*) FROM posting WHERE organization_id=org_uuid AND transaction_id=t.id)<>2
   OR EXISTS(SELECT 1 FROM posting WHERE organization_id=org_uuid AND transaction_id=t.id AND (amount<>value OR currency<>revision.currency OR bucket<>'SUPPLIER_PAYMENT' OR dimensions<>expected_dimensions))
   OR (SELECT count(*) FROM posting p JOIN ledger_account l ON l.organization_id=p.organization_id AND l.id=p.ledger_account_id
    WHERE p.organization_id=org_uuid AND p.transaction_id=t.id AND p.side='DEBIT' AND l.code='SUPPLIER_PAYABLE' AND l.account_type='CLAIM_OWNERSHIP' AND l.normal_side='CREDIT')<>1
   OR (SELECT count(*) FROM posting WHERE organization_id=org_uuid AND transaction_id=t.id AND side='CREDIT' AND ledger_account_id=funding.id)<>1
  THEN RAISE EXCEPTION 'supplier payment settles only its claim and physical funding account'; END IF;
  IF (intent->>'currentPeriod')::boolean THEN
   SELECT * INTO c FROM accounting_period WHERE organization_id=org_uuid AND id=(a.after->>'sourcePeriodId')::uuid;
   SELECT * INTO decision FROM accounting_period_event WHERE organization_id=org_uuid AND period_id=c.id ORDER BY version DESC LIMIT 1;
   IF c.id IS NULL OR NOT(c.starts_at<=paid_at AND paid_at<c.ends_at) OR decision.id::text IS DISTINCT FROM a.after->>'sourcePeriodEventId'
    OR (decision.kind='CLOSE' OR (decision.kind='REOPEN' AND decision.reopens_until<=point)) IS DISTINCT FROM true
    OR t.occurred_at<date_trunc('milliseconds',transaction_timestamp()) OR t.occurred_at>point
    OR date_trunc('month',t.occurred_at AT TIME ZONE c.timezone) IS DISTINCT FROM date_trunc('month',point AT TIME ZONE c.timezone)
    OR NOT app_financial_period_is_open(org_uuid,t.occurred_at)
   THEN RAISE EXCEPTION 'supplier payment adjustment retains its actual closed source and current open journal'; END IF;
  ELSIF t.occurred_at IS DISTINCT FROM paid_at OR a.after->>'sourcePeriodId' IS NOT NULL OR a.after->>'sourcePeriodEventId' IS NOT NULL THEN
   RAISE EXCEPTION 'supplier payment retains its actual paid instant';
  END IF;
 END IF;
 SELECT COALESCE(SUM(CASE WHEN p.side='CREDIT' THEN p.amount ELSE -p.amount END),0) INTO balance
 FROM posting p JOIN ledger_account l ON l.organization_id=p.organization_id AND l.id=p.ledger_account_id
 WHERE p.organization_id=org_uuid AND l.code='SUPPLIER_PAYABLE' AND l.account_type='CLAIM_OWNERSHIP' AND l.normal_side='CREDIT'
  AND p.currency=revision.currency AND p.dimensions->>'supplier_invoice_id'=i.id::text AND p.dimensions->>'supplier_id'=i.supplier_id::text;
 IF balance<0 OR balance>revision.amount THEN RAISE EXCEPTION 'supplier payment cannot oversettle or invent its actual claim'; END IF;
END $$;

CREATE FUNCTION app_supplier_payment_complete() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE account_code text;
BEGIN
 SELECT code INTO account_code FROM ledger_account WHERE organization_id=NEW.organization_id AND id=NEW.ledger_account_id;
 IF NEW.bucket IS DISTINCT FROM 'SUPPLIER_PAYMENT' AND NEW.dimensions->>'source' IS DISTINCT FROM 'SUPPLIER_PAYMENT'
  AND NOT(account_code='SUPPLIER_PAYABLE' AND NEW.dimensions ? 'supplier_invoice_id' AND NEW.dimensions->>'source' IS DISTINCT FROM 'SUPPLIER_INVOICE') THEN RETURN NEW; END IF;
 PERFORM app_assert_supplier_payment(NEW.organization_id,NEW.transaction_id); RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER supplier_payment_complete AFTER INSERT ON posting DEFERRABLE INITIALLY DEFERRED
 FOR EACH ROW EXECUTE FUNCTION app_supplier_payment_complete();

COMMIT;
