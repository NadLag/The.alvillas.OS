BEGIN;
-- CreateTable
CREATE TABLE "accounting_period_adjustment" (
    "id" UUID NOT NULL DEFAULT app_uuid_v7(),
    "organization_id" UUID NOT NULL,
    "expense_id" UUID NOT NULL,
    "transaction_id" UUID NOT NULL,
    "period_id" UUID NOT NULL,
    "period_event_id" UUID NOT NULL,
    "source_occurred_at" TIMESTAMPTZ(6) NOT NULL,
    "reason" VARCHAR(500) NOT NULL,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "accounting_period_adjustment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "accounting_period_adjustment_organization_id_period_id_crea_idx" ON "accounting_period_adjustment"("organization_id", "period_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "accounting_period_adjustment_organization_id_id_key" ON "accounting_period_adjustment"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "accounting_period_adjustment_organization_id_expense_id_key" ON "accounting_period_adjustment"("organization_id", "expense_id");

-- CreateIndex
CREATE UNIQUE INDEX "accounting_period_adjustment_organization_id_transaction_id_key" ON "accounting_period_adjustment"("organization_id", "transaction_id");

-- AddForeignKey
ALTER TABLE "accounting_period_adjustment" ADD CONSTRAINT "accounting_period_adjustment_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "accounting_period_adjustment" ADD CONSTRAINT "accounting_period_adjustment_organization_id_expense_id_fkey" FOREIGN KEY ("organization_id", "expense_id") REFERENCES "expense"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "accounting_period_adjustment" ADD CONSTRAINT "accounting_period_adjustment_organization_id_transaction_i_fkey" FOREIGN KEY ("organization_id", "transaction_id") REFERENCES "financial_transaction"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "accounting_period_adjustment" ADD CONSTRAINT "accounting_period_adjustment_organization_id_period_id_fkey" FOREIGN KEY ("organization_id", "period_id") REFERENCES "accounting_period"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "accounting_period_adjustment" ADD CONSTRAINT "accounting_period_adjustment_organization_id_period_event__fkey" FOREIGN KEY ("organization_id", "period_event_id") REFERENCES "accounting_period_event"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "accounting_period_adjustment" ADD CONSTRAINT "accounting_period_adjustment_organization_id_created_by_fkey" FOREIGN KEY ("organization_id", "created_by") REFERENCES "user_account"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;


ALTER TABLE accounting_period_adjustment ENABLE ROW LEVEL SECURITY;
ALTER TABLE accounting_period_adjustment FORCE ROW LEVEL SECURITY;
CREATE POLICY accounting_period_adjustment_tenant_isolation ON accounting_period_adjustment
 USING (organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid)
 WITH CHECK (organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid);

CREATE TRIGGER accounting_period_adjustment_immutable BEFORE UPDATE OR DELETE ON accounting_period_adjustment
 FOR EACH ROW EXECUTE FUNCTION app_prevent_ledger_mutation();

CREATE FUNCTION app_accounting_period_adjustment_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE source expense%ROWTYPE; submitted expense_submission%ROWTYPE; journal financial_transaction%ROWTYPE;
 calendar accounting_period%ROWTYPE; decision accounting_period_event%ROWTYPE; point timestamptz;
BEGIN
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
END $$;
CREATE TRIGGER accounting_period_adjustment_source_guard BEFORE INSERT ON accounting_period_adjustment
 FOR EACH ROW EXECUTE FUNCTION app_accounting_period_adjustment_guard();

CREATE FUNCTION app_accounting_period_adjustment_audit_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE journal financial_transaction%ROWTYPE; source expense%ROWTYPE;
BEGIN
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
END $$;
CREATE CONSTRAINT TRIGGER accounting_period_adjustment_atomic_audit AFTER INSERT ON accounting_period_adjustment
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app_accounting_period_adjustment_audit_guard();

CREATE FUNCTION app_expense_accounting_date_is_valid(expense_uuid uuid,organization_uuid uuid,journal_uuid uuid,source_timezone text)
RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT CASE WHEN EXISTS(SELECT 1 FROM accounting_period_adjustment p WHERE p.organization_id=organization_uuid AND p.expense_id=e.id)
 THEN EXISTS(SELECT 1 FROM accounting_period_adjustment p
   JOIN accounting_period c ON c.organization_id=p.organization_id AND c.id=p.period_id
   JOIN accounting_period_event v ON v.organization_id=p.organization_id AND v.id=p.period_event_id AND v.period_id=c.id
   WHERE p.organization_id=organization_uuid AND p.expense_id=e.id AND p.transaction_id=t.id
    AND p.created_by=t.created_by
    AND p.source_occurred_at=(e.occurred_on::timestamp AT TIME ZONE source_timezone)
    AND c.starts_at<=p.source_occurred_at AND p.source_occurred_at<c.ends_at
    AND (v.kind='CLOSE' OR (v.kind='REOPEN' AND v.reopens_until<=p.created_at)))
 ELSE (t.occurred_at AT TIME ZONE source_timezone)::date=e.occurred_on END
 FROM expense e JOIN financial_transaction t ON t.organization_id=e.organization_id AND t.id=journal_uuid
 WHERE e.organization_id=organization_uuid AND e.id=expense_uuid;
$$;

CREATE OR REPLACE FUNCTION app_assert_expense_posting(expense_uuid uuid,organization_uuid uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE e expense%ROWTYPE; s expense_submission%ROWTYPE; t financial_transaction%ROWTYPE; reversal financial_transaction%ROWTYPE; policy jsonb;
 owner_amount numeric; company_amount numeric; guest_amount numeric; expected_lines integer:=1;
BEGIN
 SELECT * INTO e FROM expense WHERE organization_id=organization_uuid AND id=expense_uuid;
 IF e.id IS NULL THEN RAISE EXCEPTION 'expense posting requires its tenant source'; END IF;
 IF e.transaction_id IS NULL THEN
  IF EXISTS (SELECT 1 FROM posting WHERE organization_id=organization_uuid AND dimensions->>'expense_id'=expense_uuid::text)
   THEN RAISE EXCEPTION 'expense posting requires its posted source'; END IF;
  RETURN;
 END IF;
 SELECT * INTO s FROM expense_submission WHERE organization_id=organization_uuid AND expense_id=e.id;
 SELECT * INTO t FROM financial_transaction WHERE organization_id=organization_uuid AND id=e.transaction_id;
 IF s.id IS NULL OR t.id IS NULL OR t.idempotency_key<>'expense:'||e.id||':posted' OR t.reference<>'EXPENSE:'||e.id
  OR t.reverses_transaction_id IS NOT NULL OR app_expense_accounting_date_is_valid(e.id,organization_uuid,t.id,s.snapshot->>'timezone') IS DISTINCT FROM true
  OR NOT EXISTS (SELECT 1 FROM audit_log a WHERE a.organization_id=organization_uuid AND a.resource_type='expense' AND a.resource_id=e.id
    AND a.action='expense.posted' AND a.actor_id=t.created_by AND a.after->>'transactionId'=t.id::text AND a.after->>'submissionId'=s.id::text)
 THEN RAISE EXCEPTION 'expense posting must retain its approved source and audit'; END IF;
 IF EXISTS (SELECT 1 FROM posting p WHERE p.organization_id=organization_uuid AND p.transaction_id=t.id AND (
    p.currency<>e.currency OR p.dimensions->>'expense_id' IS DISTINCT FROM e.id::text
    OR p.dimensions->>'property_id' IS DISTINCT FROM e.property_id::text OR p.dimensions->>'reservation_id' IS DISTINCT FROM e.reservation_id::text
    OR p.dimensions->>'category' IS DISTINCT FROM e.category OR p.dimensions->>'source' IS DISTINCT FROM 'EXPENSE'))
  OR (SELECT count(*) FROM posting WHERE organization_id=organization_uuid AND transaction_id=t.id AND side='CREDIT')<>1
  OR NOT EXISTS (SELECT 1 FROM posting WHERE organization_id=organization_uuid AND transaction_id=t.id AND side='CREDIT'
    AND ledger_account_id=e.funding_account_id AND amount=e.amount AND bucket='EXPENSE_PAYMENT')
 THEN RAISE EXCEPTION 'expense postings must retain their funding and financial dimensions'; END IF;
 FOR policy IN SELECT value FROM jsonb_array_elements(s.snapshot->'policies') LOOP
  owner_amount=(policy#>>'{allocation,owner,amount}')::numeric;
  IF owner_amount>0 THEN
   expected_lines=expected_lines+1;
   IF (SELECT count(*) FROM posting p JOIN ledger_account a ON a.organization_id=p.organization_id AND a.id=p.ledger_account_id
      WHERE p.organization_id=organization_uuid AND p.transaction_id=t.id AND p.side='DEBIT' AND p.amount=owner_amount
       AND p.bucket='OWNER_EXPENSE' AND p.dimensions->>'owner_id'=policy->>'ownerId'
       AND a.code='OWNER_PAYABLE' AND a.account_type='CLAIM_OWNERSHIP' AND a.normal_side='CREDIT')<>1
    THEN RAISE EXCEPTION 'expense posting must retain each approved owner charge'; END IF;
  END IF;
 END LOOP;
 company_amount=(s.snapshot#>>'{allocation,alvillas,amount}')::numeric;
 guest_amount=(s.snapshot#>>'{allocation,guest,amount}')::numeric;
 IF company_amount>0 THEN
  expected_lines=expected_lines+1;
  IF (SELECT count(*) FROM posting p JOIN ledger_account a ON a.organization_id=p.organization_id AND a.id=p.ledger_account_id
    WHERE p.organization_id=organization_uuid AND p.transaction_id=t.id AND p.side='DEBIT' AND p.amount=company_amount
     AND p.bucket='ALVILLAS_EXPENSE' AND a.code='ALVILLAS_EXPENSE' AND a.account_type='ALVILLAS_OWN' AND a.normal_side='DEBIT')<>1
   THEN RAISE EXCEPTION 'expense posting must retain its approved company charge'; END IF;
 END IF;
 IF guest_amount>0 THEN
  expected_lines=expected_lines+1;
  IF (SELECT count(*) FROM posting p JOIN ledger_account a ON a.organization_id=p.organization_id AND a.id=p.ledger_account_id
    WHERE p.organization_id=organization_uuid AND p.transaction_id=t.id AND p.side='DEBIT' AND p.amount=guest_amount
     AND p.bucket='GUEST_EXPENSE' AND a.code='GUEST_RECEIVABLE' AND a.account_type='CLAIM_OWNERSHIP' AND a.normal_side='DEBIT')<>1
   THEN RAISE EXCEPTION 'expense posting must retain its approved guest charge'; END IF;
 END IF;
 IF (SELECT count(*) FROM posting WHERE organization_id=organization_uuid AND transaction_id=t.id)<>expected_lines
  OR EXISTS (SELECT 1 FROM posting p WHERE p.organization_id=organization_uuid AND p.dimensions->>'expense_id'=e.id::text AND p.transaction_id<>t.id AND NOT EXISTS (SELECT 1 FROM financial_transaction r WHERE r.organization_id=organization_uuid AND r.id=p.transaction_id AND r.reverses_transaction_id=t.id AND e.state='VOIDED'))
 THEN RAISE EXCEPTION 'expense posting cannot contain additional financial movements'; END IF;

 SELECT * INTO reversal FROM financial_transaction WHERE organization_id=organization_uuid AND reverses_transaction_id=t.id ORDER BY id LIMIT 1;
 IF e.state='VOIDED' THEN
  IF reversal.id IS NULL OR (SELECT count(*) FROM financial_transaction WHERE organization_id=organization_uuid AND reverses_transaction_id=t.id)<>1
   OR reversal.idempotency_key<>'expense:'||e.id||':voided' OR reversal.reference<>'EXPENSE:'||e.id||':VOID'
   OR NOT EXISTS (SELECT 1 FROM audit_log a WHERE a.organization_id=organization_uuid AND a.resource_type='expense' AND a.resource_id=e.id
      AND a.action='expense.voided' AND a.actor_id=reversal.created_by AND a.after->>'transactionId'=t.id::text AND a.after->>'reversalTransactionId'=reversal.id::text)
  THEN RAISE EXCEPTION 'expense void requires one attributed mirror journal and audit'; END IF;
  IF EXISTS (
   WITH expected AS (SELECT ledger_account_id,CASE WHEN side='DEBIT' THEN 'CREDIT' ELSE 'DEBIT' END AS side,amount,currency,bucket,dimensions
      FROM posting WHERE organization_id=organization_uuid AND transaction_id=t.id),
    actual AS (SELECT ledger_account_id,side::text,amount,currency,bucket,dimensions FROM posting WHERE organization_id=organization_uuid AND transaction_id=reversal.id)
   (SELECT * FROM expected EXCEPT ALL SELECT * FROM actual) UNION ALL (SELECT * FROM actual EXCEPT ALL SELECT * FROM expected)
  ) THEN RAISE EXCEPTION 'expense void must mirror every original posting exactly'; END IF;
 ELSIF reversal.id IS NOT NULL THEN RAISE EXCEPTION 'expense reversal requires its atomic void state';
 END IF;
END $$;
COMMIT;
