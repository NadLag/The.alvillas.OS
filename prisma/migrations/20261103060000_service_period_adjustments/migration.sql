BEGIN;
-- AlterTable
ALTER TABLE "accounting_period_adjustment" ADD COLUMN     "service_allocation_posting_id" UUID;

-- CreateIndex
CREATE UNIQUE INDEX "service_posting_period_adjustment_unique" ON "accounting_period_adjustment"("organization_id", "service_allocation_posting_id");

-- AddForeignKey
ALTER TABLE "accounting_period_adjustment" ADD CONSTRAINT "service_posting_period_adjustment_fk" FOREIGN KEY ("organization_id", "service_allocation_posting_id") REFERENCES "service_allocation_posting"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;


ALTER TABLE accounting_period_adjustment DROP CONSTRAINT accounting_period_adjustment_one_source;
ALTER TABLE accounting_period_adjustment ADD CONSTRAINT accounting_period_adjustment_one_source CHECK (num_nonnulls(expense_id,invoice_recognition_line_id,employee_recognition_line_id,service_allocation_posting_id)=1);
CREATE FUNCTION app_assert_service_period_adjustment(a accounting_period_adjustment) RETURNS void LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE link service_allocation_posting; subject service_financial_source; admission service_allocation_admission;
 journal financial_transaction; calendar accounting_period; decision accounting_period_event; point timestamptz;
BEGIN
 PERFORM pg_advisory_xact_lock_shared(hashtextextended(a.organization_id::text||':accounting-period',0)); point=clock_timestamp();
 SELECT * INTO link FROM service_allocation_posting WHERE organization_id=a.organization_id AND id=a.service_allocation_posting_id;
 SELECT * INTO subject FROM service_financial_source WHERE organization_id=a.organization_id AND id=link.source_id;
 SELECT * INTO admission FROM service_allocation_admission WHERE organization_id=a.organization_id AND id=link.admission_id;
 SELECT * INTO journal FROM financial_transaction WHERE organization_id=a.organization_id AND id=a.transaction_id;
 SELECT * INTO calendar FROM accounting_period WHERE organization_id=a.organization_id AND id=a.period_id;
 SELECT * INTO decision FROM accounting_period_event WHERE organization_id=a.organization_id AND period_id=calendar.id ORDER BY version DESC LIMIT 1;
 IF link.id IS NULL OR subject.id IS NULL OR admission.id IS NULL OR journal.id IS NULL OR calendar.id IS NULL
  OR link.kind<>'RECOGNITION' OR admission.source_id<>subject.id OR link.transaction_id<>journal.id
  OR num_nonnulls(a.expense_id,a.invoice_recognition_line_id,a.employee_recognition_line_id,a.service_allocation_posting_id)<>1
  OR journal.created_by IS DISTINCT FROM a.created_by OR link.created_by IS DISTINCT FROM a.created_by
  OR journal.reverses_transaction_id IS NOT NULL OR link.reason IS DISTINCT FROM a.reason
  OR NOT EXISTS(SELECT 1 FROM service_allocation_posting WHERE organization_id=a.organization_id AND id=link.id AND xmin::text=pg_current_xact_id()::text)
  OR NOT EXISTS(SELECT 1 FROM financial_transaction WHERE organization_id=a.organization_id AND id=journal.id AND xmin::text=pg_current_xact_id()::text)
 THEN RAISE EXCEPTION 'service period adjustment requires its actual new recognition and original tenant admission'; END IF;
 IF length(btrim(a.reason)) NOT BETWEEN 6 AND 500
  OR a.source_occurred_at IS DISTINCT FROM (admission.snapshot->'source'->>'completedAt')::timestamptz
  OR NOT(calendar.starts_at<=a.source_occurred_at AND a.source_occurred_at<calendar.ends_at)
  OR decision.id IS DISTINCT FROM a.period_event_id
  OR (decision.kind='CLOSE' OR(decision.kind='REOPEN' AND decision.reopens_until<=point)) IS DISTINCT FROM true
 THEN RAISE EXCEPTION 'service period adjustment requires the actual closed source period and latest decision'; END IF;
 IF journal.occurred_at=a.source_occurred_at OR journal.occurred_at<date_trunc('milliseconds',transaction_timestamp()) OR journal.occurred_at>point
  OR date_trunc('month',journal.occurred_at AT TIME ZONE calendar.timezone) IS DISTINCT FROM date_trunc('month',point AT TIME ZONE calendar.timezone)
  OR NOT app_financial_period_is_open(a.organization_id,journal.occurred_at)
 THEN RAISE EXCEPTION 'service period adjustment must post in the current open period'; END IF;
END $$;

CREATE FUNCTION app_assert_service_period_adjustment_audit(a accounting_period_adjustment) RETURNS void LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE link service_allocation_posting; subject service_financial_source; receipt cash_collection; journal financial_transaction;
BEGIN
 SELECT * INTO link FROM service_allocation_posting WHERE organization_id=a.organization_id AND id=a.service_allocation_posting_id;
 SELECT * INTO subject FROM service_financial_source WHERE organization_id=a.organization_id AND id=link.source_id;
 SELECT * INTO receipt FROM cash_collection WHERE organization_id=a.organization_id AND id=subject.cash_collection_id;
 SELECT * INTO journal FROM financial_transaction WHERE organization_id=a.organization_id AND id=a.transaction_id;
 IF link.id IS NULL OR subject.id IS NULL OR receipt.id IS NULL OR journal.id IS NULL OR link.transaction_id IS DISTINCT FROM journal.id
  OR NOT EXISTS(SELECT 1 FROM audit_log x WHERE x.organization_id=a.organization_id AND x.actor_id=a.created_by
   AND x.resource_type='service_allocation' AND x.resource_id=subject.id AND x.property_scope_id=receipt.property_id
   AND x.action='finance.period.adjustment_posted' AND x.reason=a.reason
   AND x.after->>'adjustmentId'=a.id::text AND x.after->>'serviceAllocationPostingId'=link.id::text
   AND x.after->>'sourceId'=subject.id::text AND x.after->>'admissionId'=link.admission_id::text
   AND x.after->>'transactionId'=journal.id::text AND x.after->>'sourcePeriodId'=a.period_id::text
   AND x.after->>'sourcePeriodEventId'=a.period_event_id::text
   AND (x.after->>'sourceOccurredAt')::timestamptz=a.source_occurred_at AND (x.after->>'postedAt')::timestamptz=journal.occurred_at)
  OR NOT EXISTS(SELECT 1 FROM audit_log x WHERE x.organization_id=a.organization_id AND x.actor_id=a.created_by
   AND x.resource_type='service_allocation' AND x.resource_id=subject.id AND x.property_scope_id=receipt.property_id
   AND x.action='service_allocation.recognized' AND x.reason=a.reason
   AND x.after->>'postingId'=link.id::text AND x.after->>'admissionId'=link.admission_id::text
   AND x.after->>'transactionId'=journal.id::text AND x.after->>'accountingPeriodAdjustmentId'=a.id::text
   AND x.after->>'postingDateMode'='ADJUST_CLOSED_SOURCES')
 THEN RAISE EXCEPTION 'service period adjustment requires its complete private atomic source and reasoned audits'; END IF;
END $$;

CREATE OR REPLACE FUNCTION public.app_accounting_period_adjustment_guard()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE source expense%ROWTYPE; submitted expense_submission%ROWTYPE; journal financial_transaction%ROWTYPE;
 calendar accounting_period%ROWTYPE; decision accounting_period_event%ROWTYPE; point timestamptz;
BEGIN
 IF NEW.service_allocation_posting_id IS NOT NULL THEN
  PERFORM app_assert_service_period_adjustment(NEW);
  NEW.created_at=clock_timestamp();
  RETURN NEW;
 END IF;
 IF NEW.employee_recognition_line_id IS NOT NULL THEN
  PERFORM app_assert_employee_period_adjustment(NEW);
  NEW.created_at=clock_timestamp();
  RETURN NEW;
 END IF;
 IF NEW.invoice_recognition_line_id IS NOT NULL THEN
  PERFORM app_assert_invoice_period_adjustment(NEW);
  NEW.created_at=clock_timestamp();
  RETURN NEW;
 END IF;
 PERFORM pg_advisory_xact_lock_shared(hashtextextended(NEW.organization_id::text||':accounting-period',0));
 point:=clock_timestamp();
 SELECT * INTO source FROM expense WHERE organization_id=NEW.organization_id AND id=NEW.expense_id;
 SELECT * INTO submitted FROM expense_submission WHERE organization_id=NEW.organization_id AND expense_id=source.id;
 SELECT * INTO journal FROM financial_transaction WHERE organization_id=NEW.organization_id AND id=NEW.transaction_id;
 SELECT * INTO calendar FROM accounting_period WHERE organization_id=NEW.organization_id AND id=NEW.period_id;
 SELECT * INTO decision FROM accounting_period_event WHERE organization_id=NEW.organization_id AND period_id=calendar.id ORDER BY version DESC LIMIT 1;
 IF source.id IS NULL OR submitted.id IS NULL OR journal.id IS NULL OR calendar.id IS NULL
  OR source.state<>'APPROVED' OR source.transaction_id IS NOT NULL
  OR journal.created_by IS DISTINCT FROM NEW.created_by OR journal.reverses_transaction_id IS NOT NULL
  OR journal.sealed IS DISTINCT FROM false OR journal.reference IS DISTINCT FROM 'EXPENSE:'||source.id
  OR journal.idempotency_key IS DISTINCT FROM 'expense:'||source.id||':posted'
 THEN RAISE EXCEPTION 'period adjustment requires its approved unposted expense and new journal'; END IF;
 IF length(btrim(NEW.reason)) NOT BETWEEN 6 AND 500
  OR NEW.source_occurred_at IS DISTINCT FROM (source.occurred_on::timestamp AT TIME ZONE (submitted.snapshot->>'timezone'))
  OR NOT (calendar.starts_at<=NEW.source_occurred_at AND NEW.source_occurred_at<calendar.ends_at)
  OR decision.id IS DISTINCT FROM NEW.period_event_id
  OR (decision.kind='CLOSE' OR (decision.kind='REOPEN' AND decision.reopens_until<=point)) IS DISTINCT FROM true
 THEN RAISE EXCEPTION 'period adjustment must reference the actual closed source period and decision'; END IF;
 IF journal.occurred_at<date_trunc('milliseconds',transaction_timestamp()) OR journal.occurred_at>point
  OR date_trunc('month',journal.occurred_at AT TIME ZONE calendar.timezone) IS DISTINCT FROM date_trunc('month',point AT TIME ZONE calendar.timezone)
  OR NOT app_financial_period_is_open(NEW.organization_id,journal.occurred_at)
 THEN RAISE EXCEPTION 'period adjustment must post in the current open period'; END IF;
 NEW.created_at:=point;
 RETURN NEW;
END $function$;


CREATE OR REPLACE FUNCTION public.app_accounting_period_adjustment_audit_guard()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE journal financial_transaction%ROWTYPE; source expense%ROWTYPE;
BEGIN
 IF NEW.service_allocation_posting_id IS NOT NULL THEN
  PERFORM app_assert_service_period_adjustment_audit(NEW);
  RETURN NEW;
 END IF;
 IF NEW.employee_recognition_line_id IS NOT NULL THEN
  PERFORM app_assert_employee_period_adjustment_audit(NEW);
  RETURN NEW;
 END IF;
 IF NEW.invoice_recognition_line_id IS NOT NULL THEN
  PERFORM app_assert_invoice_period_adjustment_audit(NEW);
  RETURN NEW;
 END IF;
 SELECT * INTO journal FROM financial_transaction WHERE organization_id=NEW.organization_id AND id=NEW.transaction_id;
 SELECT * INTO source FROM expense WHERE organization_id=NEW.organization_id AND id=NEW.expense_id;
 IF source.transaction_id IS DISTINCT FROM journal.id OR source.state NOT IN ('POSTED','VOIDED')
  OR NOT EXISTS(SELECT 1 FROM audit_log a WHERE a.organization_id=NEW.organization_id AND a.actor_id=NEW.created_by
   AND a.resource_type='financial_transaction' AND a.resource_id=journal.id AND a.action='finance.period.adjustment_posted' AND a.reason=NEW.reason
   AND a.after->>'adjustmentId'=NEW.id::text AND a.after->>'expenseId'=NEW.expense_id::text
   AND a.after->>'transactionId'=journal.id::text AND a.after->>'sourcePeriodId'=NEW.period_id::text
   AND a.after->>'sourcePeriodEventId'=NEW.period_event_id::text
   AND (a.after->>'sourceOccurredAt')::timestamptz=NEW.source_occurred_at AND (a.after->>'postedAt')::timestamptz=journal.occurred_at)
  OR NOT EXISTS(SELECT 1 FROM audit_log a WHERE a.organization_id=NEW.organization_id AND a.actor_id=NEW.created_by
   AND a.resource_type='expense' AND a.resource_id=source.id AND a.action='expense.posted' AND a.reason=NEW.reason
   AND a.after->>'transactionId'=journal.id::text AND a.after->>'accountingPeriodAdjustmentId'=NEW.id::text
   AND a.after->>'postingDateMode'='CURRENT_OPEN_PERIOD')
 THEN RAISE EXCEPTION 'period adjustment requires its complete atomic source and reasoned audits'; END IF;
 RETURN NEW;
END $function$;


CREATE OR REPLACE FUNCTION public.app_service_posting_exact_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE adjustment accounting_period_adjustment; subject service_financial_source; receipt cash_collection; admission service_allocation_admission; journal financial_transaction; original service_allocation_posting;
 expected jsonb:='[]'; actual jsonb; dimensions jsonb; detail jsonb; component jsonb; owner_row jsonb; owner_count integer; owner_position integer; component_amount numeric; owner_amount numeric; remaining numeric; company_amount numeric:=0; expected_unallocated uuid;
BEGIN
 SELECT * INTO adjustment FROM accounting_period_adjustment WHERE organization_id=NEW.organization_id AND service_allocation_posting_id=NEW.id;
 IF adjustment.id IS NOT NULL THEN PERFORM app_assert_service_period_adjustment(adjustment); END IF;
 SELECT * INTO subject FROM service_financial_source WHERE organization_id=NEW.organization_id AND id=NEW.source_id;
 SELECT * INTO receipt FROM cash_collection WHERE organization_id=NEW.organization_id AND id=subject.cash_collection_id;
 SELECT * INTO admission FROM service_allocation_admission WHERE organization_id=NEW.organization_id AND id=NEW.admission_id;
 SELECT * INTO journal FROM financial_transaction WHERE organization_id=NEW.organization_id AND id=NEW.transaction_id;
 IF NOT journal.sealed THEN RAISE EXCEPTION 'a service allocation must acknowledge an actual sealed native journal'; END IF;
 SELECT jsonb_agg(app_service_journal_row(a.code,p.side,p.amount,p.currency,p.bucket,p.dimensions) ORDER BY app_service_journal_row(a.code,p.side,p.amount,p.currency,p.bucket,p.dimensions)::text) INTO actual
  FROM posting p JOIN ledger_account a ON a.organization_id=p.organization_id AND a.id=p.ledger_account_id WHERE p.organization_id=NEW.organization_id AND p.transaction_id=NEW.transaction_id;
 IF NEW.kind='RECOGNITION' THEN
  IF (journal.occurred_at IS DISTINCT FROM(admission.snapshot->'source'->>'completedAt')::timestamptz AND adjustment.id IS NULL)
   OR NOT EXISTS(SELECT 1 FROM financial_transaction t WHERE t.organization_id=NEW.organization_id AND t.id=receipt.transaction_id AND t.sealed AND NOT EXISTS(SELECT 1 FROM financial_transaction reversal WHERE reversal.organization_id=t.organization_id AND reversal.reverses_transaction_id=t.id))
   OR EXISTS(SELECT 1 FROM jsonb_array_elements(admission.snapshot->'providerCosts') cost WHERE
    NOT EXISTS(SELECT 1 FROM service_allocation_provider_binding binding WHERE binding.organization_id=NEW.organization_id AND binding.id::text=cost->>'bindingId' AND binding.source_id=subject.id AND binding.state='ATTACHED'
     AND binding.id=(SELECT id FROM service_allocation_provider_binding latest WHERE latest.organization_id=binding.organization_id AND latest.supplier_invoice_line_id IS NOT DISTINCT FROM binding.supplier_invoice_line_id AND latest.employee_cost_id IS NOT DISTINCT FROM binding.employee_cost_id ORDER BY version DESC LIMIT 1))
    OR NOT EXISTS(SELECT 1 FROM financial_transaction t WHERE t.organization_id=NEW.organization_id AND t.id::text=cost->>'transactionId' AND t.sealed AND NOT EXISTS(SELECT 1 FROM financial_transaction reversal WHERE reversal.organization_id=t.organization_id AND reversal.reverses_transaction_id=t.id)))
  THEN RAISE EXCEPTION 'service recognition requires its original completion instant, unreversed cash and current native provider evidence'; END IF;
  SELECT p.ledger_account_id INTO expected_unallocated FROM posting p JOIN ledger_account a ON a.organization_id=p.organization_id AND a.id=p.ledger_account_id WHERE p.organization_id=NEW.organization_id AND p.transaction_id=receipt.transaction_id AND p.side='CREDIT' AND a.code='UNALLOCATED_COLLECTIONS';
  IF expected_unallocated IS NULL OR NOT EXISTS(SELECT 1 FROM posting WHERE organization_id=NEW.organization_id AND transaction_id=journal.id AND side='DEBIT' AND ledger_account_id=expected_unallocated)
  THEN RAISE EXCEPTION 'service allocation must release the actual original unallocated collection account'; END IF;
  dimensions=jsonb_build_object('organization_id',NEW.organization_id::text,'property_id',receipt.property_id::text,'cash_collection_id',receipt.id::text,'task_id',receipt.task_id::text,'completion_event_id',subject.completion_event_id::text,'service_key',admission.service_key,'service_allocation_policy_id',admission.allocation_rule_id::text,'service_source_id',subject.id::text,'service_admission_id',admission.id::text,'source','SERVICE_ALLOCATION');
  IF receipt.reservation_id IS NOT NULL THEN dimensions=dimensions||jsonb_build_object('reservation_id',receipt.reservation_id::text); END IF;
  expected=expected||jsonb_build_array(app_service_journal_row('UNALLOCATED_COLLECTIONS','DEBIT',receipt.amount,receipt.currency,'SERVICE_ALLOCATION',dimensions));
  FOR component IN SELECT value FROM jsonb_array_elements(admission.snapshot->'parts') LOOP
   component_amount=(component->'amount'->>'amount')::numeric;IF component_amount=0 THEN CONTINUE; END IF;
   detail=dimensions||jsonb_build_object('service_component',component->>'key');
   IF component->>'beneficiary'='OWNER' THEN
    remaining=component_amount;owner_position=0;owner_count=jsonb_array_length(admission.snapshot->'owners');
    FOR owner_row IN SELECT value FROM jsonb_array_elements(admission.snapshot->'owners') ORDER BY value->>'ownerId' LOOP
     owner_position=owner_position+1;owner_amount=CASE WHEN owner_position=owner_count THEN remaining ELSE least(remaining,round(component_amount*(owner_row->>'shareBps')::numeric/10000,2)) END;remaining=remaining-owner_amount;
     IF owner_amount>0 THEN expected=expected||jsonb_build_array(app_service_journal_row('OWNER_PAYABLE','CREDIT',owner_amount,receipt.currency,'OWNER_SERVICES',detail||jsonb_build_object('owner_id',owner_row->>'ownerId'))); END IF;
    END LOOP;
    IF owner_count=0 OR remaining<>0 THEN RAISE EXCEPTION 'actual original owner shares must conserve every service cent'; END IF;
   ELSIF component->>'beneficiary'='TAX' THEN
    expected=expected||jsonb_build_array(app_service_journal_row('SERVICE_TAX_PAYABLE','CREDIT',component_amount,receipt.currency,'SERVICE_TAX',detail||jsonb_build_object('tax_rule_key',component->>'taxRuleKey')));
   ELSE company_amount=company_amount+component_amount;
   END IF;
  END LOOP;
  IF company_amount>0 THEN expected=expected||jsonb_build_array(app_service_journal_row('ALVILLAS_SERVICE_REVENUE','CREDIT',company_amount,receipt.currency,'ALVILLAS_SERVICE_REVENUE',dimensions)); END IF;
 ELSE
  SELECT * INTO original FROM service_allocation_posting WHERE organization_id=NEW.organization_id AND id=NEW.reverses_posting_id;
  SELECT jsonb_agg(app_service_journal_row(a.code,CASE WHEN p.side='DEBIT' THEN 'CREDIT' ELSE 'DEBIT' END,p.amount,p.currency,p.bucket,p.dimensions)) INTO expected
   FROM posting p JOIN ledger_account a ON a.organization_id=p.organization_id AND a.id=p.ledger_account_id WHERE p.organization_id=NEW.organization_id AND p.transaction_id=original.transaction_id;
 END IF;
 SELECT jsonb_agg(value ORDER BY value::text) INTO expected FROM jsonb_array_elements(expected);
 IF expected IS DISTINCT FROM actual OR EXISTS(SELECT 1 FROM posting p JOIN ledger_account a ON a.organization_id=p.organization_id AND a.id=p.ledger_account_id WHERE p.organization_id=NEW.organization_id AND p.transaction_id=journal.id AND(a.archived_at IS NOT NULL OR
   CASE WHEN a.code='ALVILLAS_SERVICE_REVENUE' THEN a.account_type<>'ALVILLAS_OWN' ELSE a.account_type<>'CLAIM_OWNERSHIP' END OR a.normal_side<>'CREDIT'))
 THEN RAISE EXCEPTION 'service allocation must preserve exact original Money, ownership, tax and private aggregated company revenue'; END IF;
 RETURN NULL;
END $function$;


COMMIT;
