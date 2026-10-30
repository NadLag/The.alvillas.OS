BEGIN;
-- AlterTable
ALTER TABLE "accounting_period_adjustment" ADD COLUMN     "invoice_recognition_line_id" UUID,
ALTER COLUMN "expense_id" DROP NOT NULL;

-- CreateTable
CREATE TABLE "supplier_invoice_recognition" (
    "id" UUID NOT NULL DEFAULT app_uuid_v7(),
    "organization_id" UUID NOT NULL,
    "invoice_id" UUID NOT NULL,
    "submission_id" UUID NOT NULL,
    "invoice_version" INTEGER NOT NULL,
    "current_period" BOOLEAN NOT NULL DEFAULT false,
    "idempotency_key" UUID NOT NULL,
    "request_fingerprint" TEXT NOT NULL,
    "reason" VARCHAR(500) NOT NULL,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "supplier_invoice_recognition_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "supplier_invoice_recognition_line" (
    "id" UUID NOT NULL DEFAULT app_uuid_v7(),
    "organization_id" UUID NOT NULL,
    "recognition_id" UUID NOT NULL,
    "invoice_line_id" UUID NOT NULL,
    "transaction_id" UUID NOT NULL,
    "source_occurred_at" TIMESTAMPTZ(6) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "supplier_invoice_recognition_line_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "supplier_invoice_recognition_organization_id_created_at_id_idx" ON "supplier_invoice_recognition"("organization_id", "created_at", "id");

-- CreateIndex
CREATE UNIQUE INDEX "supplier_invoice_recognition_organization_id_id_key" ON "supplier_invoice_recognition"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "supplier_invoice_recognition_organization_id_invoice_id_key" ON "supplier_invoice_recognition"("organization_id", "invoice_id");

-- CreateIndex
CREATE UNIQUE INDEX "supplier_invoice_recognition_organization_id_submission_id_key" ON "supplier_invoice_recognition"("organization_id", "submission_id");

-- CreateIndex
CREATE UNIQUE INDEX "supplier_invoice_recognition_organization_id_idempotency_ke_key" ON "supplier_invoice_recognition"("organization_id", "idempotency_key");

-- CreateIndex
CREATE INDEX "supplier_invoice_recognition_line_organization_id_recogniti_idx" ON "supplier_invoice_recognition_line"("organization_id", "recognition_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "supplier_invoice_recognition_line_organization_id_id_key" ON "supplier_invoice_recognition_line"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "supplier_invoice_recognition_line_organization_id_invoice_l_key" ON "supplier_invoice_recognition_line"("organization_id", "invoice_line_id");

-- CreateIndex
CREATE UNIQUE INDEX "supplier_invoice_recognition_line_organization_id_transacti_key" ON "supplier_invoice_recognition_line"("organization_id", "transaction_id");

-- CreateIndex
CREATE UNIQUE INDEX "accounting_period_adjustment_organization_id_invoice_recogn_key" ON "accounting_period_adjustment"("organization_id", "invoice_recognition_line_id");

-- AddForeignKey
ALTER TABLE "accounting_period_adjustment" ADD CONSTRAINT "accounting_period_adjustment_organization_id_invoice_recog_fkey" FOREIGN KEY ("organization_id", "invoice_recognition_line_id") REFERENCES "supplier_invoice_recognition_line"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "supplier_invoice_recognition" ADD CONSTRAINT "supplier_invoice_recognition_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "supplier_invoice_recognition" ADD CONSTRAINT "supplier_invoice_recognition_organization_id_invoice_id_fkey" FOREIGN KEY ("organization_id", "invoice_id") REFERENCES "supplier_invoice"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "supplier_invoice_recognition" ADD CONSTRAINT "supplier_invoice_recognition_organization_id_submission_id_fkey" FOREIGN KEY ("organization_id", "submission_id") REFERENCES "supplier_invoice_submission"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "supplier_invoice_recognition" ADD CONSTRAINT "supplier_invoice_recognition_organization_id_created_by_fkey" FOREIGN KEY ("organization_id", "created_by") REFERENCES "user_account"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "supplier_invoice_recognition_line" ADD CONSTRAINT "supplier_invoice_recognition_line_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "supplier_invoice_recognition_line" ADD CONSTRAINT "supplier_invoice_recognition_line_organization_id_recognit_fkey" FOREIGN KEY ("organization_id", "recognition_id") REFERENCES "supplier_invoice_recognition"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "supplier_invoice_recognition_line" ADD CONSTRAINT "supplier_invoice_recognition_line_organization_id_invoice__fkey" FOREIGN KEY ("organization_id", "invoice_line_id") REFERENCES "supplier_invoice_line"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "supplier_invoice_recognition_line" ADD CONSTRAINT "supplier_invoice_recognition_line_organization_id_transact_fkey" FOREIGN KEY ("organization_id", "transaction_id") REFERENCES "financial_transaction"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

ALTER TABLE supplier_invoice_recognition ENABLE ROW LEVEL SECURITY;
ALTER TABLE supplier_invoice_recognition FORCE ROW LEVEL SECURITY;
CREATE POLICY supplier_invoice_recognition_tenant_isolation ON supplier_invoice_recognition
 USING (organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid)
 WITH CHECK (organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid);
ALTER TABLE supplier_invoice_recognition_line ENABLE ROW LEVEL SECURITY;
ALTER TABLE supplier_invoice_recognition_line FORCE ROW LEVEL SECURITY;
CREATE POLICY supplier_invoice_recognition_line_tenant_isolation ON supplier_invoice_recognition_line
 USING (organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid)
 WITH CHECK (organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid);
CREATE TRIGGER supplier_invoice_recognition_immutable BEFORE UPDATE OR DELETE ON supplier_invoice_recognition
 FOR EACH ROW EXECUTE FUNCTION app_prevent_ledger_mutation();
CREATE TRIGGER supplier_invoice_recognition_line_immutable BEFORE UPDATE OR DELETE ON supplier_invoice_recognition_line
 FOR EACH ROW EXECUTE FUNCTION app_prevent_ledger_mutation();
ALTER TABLE supplier_invoice_recognition ADD CONSTRAINT supplier_invoice_recognition_fields CHECK
 (invoice_version>0 AND length(btrim(reason)) BETWEEN 6 AND 500 AND request_fingerprint ~ '^[0-9a-f]{64}$');
ALTER TABLE accounting_period_adjustment ADD CONSTRAINT accounting_period_adjustment_one_source CHECK
 ((expense_id IS NOT NULL)::int+(invoice_recognition_line_id IS NOT NULL)::int=1);

CREATE FUNCTION app_supplier_invoice_recognition_admission() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE i supplier_invoice%ROWTYPE; s supplier_invoice_submission%ROWTYPE;
BEGIN
 SELECT * INTO i FROM supplier_invoice WHERE organization_id=NEW.organization_id AND id=NEW.invoice_id;
 SELECT * INTO s FROM supplier_invoice_submission WHERE organization_id=NEW.organization_id AND id=NEW.submission_id;
 IF i.id IS NULL OR s.id IS NULL OR i.state<>'APPROVED' OR i.archived_at IS NOT NULL OR i.version<>NEW.invoice_version
  OR i.current_submission_id IS DISTINCT FROM s.id OR s.invoice_id<>i.id OR i.current_revision_id IS DISTINCT FROM s.revision_id
  OR EXISTS(SELECT 1 FROM supplier v WHERE v.organization_id=i.organization_id AND v.id=i.supplier_id AND v.archived_at IS NOT NULL)
  OR (jsonb_array_length(s.snapshot->'stages')>0 AND NOT EXISTS(SELECT 1 FROM approval_request a
    WHERE a.organization_id=i.organization_id AND a.invoice_submission_id=s.id AND a.state='APPROVED'
      AND NOT EXISTS(SELECT 1 FROM approval_stage p WHERE p.organization_id=a.organization_id AND p.approval_id=a.id AND p.state<>'APPROVED')))
 THEN RAISE EXCEPTION 'supplier recognition requires its actual current approved invoice and review source'; END IF;
 NEW.created_at=clock_timestamp(); RETURN NEW;
END $$;
CREATE TRIGGER supplier_invoice_recognition_admission BEFORE INSERT ON supplier_invoice_recognition
 FOR EACH ROW EXECUTE FUNCTION app_supplier_invoice_recognition_admission();

CREATE FUNCTION app_assert_supplier_invoice_recognition_line(org_uuid uuid,line_uuid uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE r supplier_invoice_recognition%ROWTYPE; s supplier_invoice_submission%ROWTYPE; i supplier_invoice%ROWTYPE;
 l supplier_invoice_line%ROWTYPE; link supplier_invoice_recognition_line%ROWTYPE; t financial_transaction%ROWTYPE;
 source_line jsonb; policy jsonb; owner_policy jsonb; value numeric; expected_count integer;
BEGIN
 SELECT * INTO link FROM supplier_invoice_recognition_line WHERE organization_id=org_uuid AND id=line_uuid;
 IF link.id IS NULL THEN RAISE EXCEPTION 'supplier posting requires its actual recognition line'; END IF;
 SELECT * INTO r FROM supplier_invoice_recognition WHERE organization_id=org_uuid AND id=link.recognition_id;
 SELECT * INTO s FROM supplier_invoice_submission WHERE organization_id=org_uuid AND id=r.submission_id;
 SELECT * INTO i FROM supplier_invoice WHERE organization_id=org_uuid AND id=r.invoice_id;
 IF r.id IS NULL OR s.id IS NULL OR i.id IS NULL OR i.state<>'APPROVED' OR i.current_submission_id IS DISTINCT FROM s.id
  OR i.current_revision_id IS DISTINCT FROM s.revision_id OR i.version<>r.invoice_version
 THEN RAISE EXCEPTION 'recognition must retain its actual approved invoice revision'; END IF;
  SELECT * INTO l FROM supplier_invoice_line WHERE organization_id=org_uuid AND id=link.invoice_line_id;
  SELECT * INTO t FROM financial_transaction WHERE organization_id=org_uuid AND id=link.transaction_id;
  SELECT x INTO source_line FROM jsonb_array_elements(s.snapshot->'lines') x WHERE x->>'id'=l.id::text;
  policy=source_line->'policy';
  IF l.id IS NULL OR l.revision_id<>s.revision_id OR t.id IS NULL OR policy IS NULL OR t.created_by<>r.created_by OR t.reverses_transaction_id IS NOT NULL
   OR t.idempotency_key IS DISTINCT FROM 'supplier-invoice:'||s.id||':'||l.id||':recognized'
   OR t.reference IS DISTINCT FROM 'SUPPLIER-INVOICE:'||i.id||':'||l.id
   OR link.source_occurred_at IS DISTINCT FROM (s.occurred_on::timestamp AT TIME ZONE (policy->>'timezone'))
   OR policy->>'invoiceId' IS DISTINCT FROM i.id::text OR policy->>'revisionId' IS DISTINCT FROM s.revision_id::text
   OR policy->>'lineId' IS DISTINCT FROM l.id::text OR policy->>'propertyId' IS DISTINCT FROM l.property_id::text
   OR policy->>'reservationId' IS DISTINCT FROM l.reservation_id::text OR policy->>'category' IS DISTINCT FROM l.category
   OR (policy#>>'{amount,amount}')::numeric IS DISTINCT FROM l.amount OR policy#>>'{amount,currency}' IS DISTINCT FROM l.currency
  THEN RAISE EXCEPTION 'supplier recognition journal must retain its exact original cost source'; END IF;
  IF NOT EXISTS(SELECT 1 FROM accounting_period_adjustment a WHERE a.organization_id=org_uuid AND a.invoice_recognition_line_id=link.id) THEN
   IF t.occurred_at IS DISTINCT FROM link.source_occurred_at THEN RAISE EXCEPTION 'supplier costs retain their actual original calendar dates'; END IF;
  ELSIF NOT r.current_period OR NOT EXISTS(SELECT 1 FROM accounting_period_adjustment a WHERE a.organization_id=org_uuid
    AND a.invoice_recognition_line_id=link.id AND a.transaction_id=t.id AND a.source_occurred_at=link.source_occurred_at AND a.created_by=r.created_by)
   THEN RAISE EXCEPTION 'closed invoice costs require their actual attributed adjustment'; END IF;
  IF EXISTS(SELECT 1 FROM posting p WHERE p.organization_id=org_uuid AND p.transaction_id=t.id AND (
    p.currency<>l.currency OR p.dimensions->>'supplier_invoice_id' IS DISTINCT FROM i.id::text
    OR p.dimensions->>'supplier_id' IS DISTINCT FROM i.supplier_id::text OR p.dimensions->>'supplier_invoice_line_id' IS DISTINCT FROM l.id::text
    OR p.dimensions->>'property_id' IS DISTINCT FROM l.property_id::text OR p.dimensions->>'reservation_id' IS DISTINCT FROM l.reservation_id::text
    OR p.dimensions->>'category' IS DISTINCT FROM l.category OR p.dimensions->>'cost_center' IS DISTINCT FROM l.cost_center
    OR p.dimensions->>'source' IS DISTINCT FROM 'SUPPLIER_INVOICE' OR p.dimensions ? 'expense_id'
    OR (p.bucket<>'OWNER_EXPENSE' AND p.dimensions ? 'owner_id')))
   OR (SELECT count(*) FROM posting p WHERE p.organization_id=org_uuid AND p.transaction_id=t.id AND p.side='CREDIT')<>1
   OR (SELECT count(*) FROM posting p JOIN ledger_account a ON a.organization_id=p.organization_id AND a.id=p.ledger_account_id
     WHERE p.organization_id=org_uuid AND p.transaction_id=t.id AND p.side='CREDIT' AND p.amount=l.amount AND p.bucket='SUPPLIER_INVOICE'
      AND a.code='SUPPLIER_PAYABLE' AND a.account_type='CLAIM_OWNERSHIP' AND a.normal_side='CREDIT')<>1
  THEN RAISE EXCEPTION 'supplier recognition credits only its actual claim and preserves cost dimensions'; END IF;
  expected_count=1;
  IF l.property_id IS NOT NULL THEN
   FOR owner_policy IN SELECT x FROM jsonb_array_elements(policy->'policies') x LOOP
    value=(owner_policy#>>'{allocation,owner,amount}')::numeric;
    IF value>0 THEN
     expected_count=expected_count+1;
     IF (SELECT count(*) FROM posting p JOIN ledger_account a ON a.organization_id=p.organization_id AND a.id=p.ledger_account_id
       WHERE p.organization_id=org_uuid AND p.transaction_id=t.id AND p.side='DEBIT' AND p.amount=value AND p.bucket='OWNER_EXPENSE'
        AND p.dimensions->>'owner_id'=owner_policy->>'ownerId' AND a.code='OWNER_PAYABLE' AND a.account_type='CLAIM_OWNERSHIP' AND a.normal_side='CREDIT')<>1
     THEN RAISE EXCEPTION 'supplier recognition retains every approved owner charge to the cent'; END IF;
    END IF;
   END LOOP;
  ELSIF (policy#>>'{allocation,owner,amount}')::numeric<>0 OR (policy#>>'{allocation,guest,amount}')::numeric<>0 THEN
   RAISE EXCEPTION 'company supplier costs cannot invent property or owner sources';
  END IF;
  value=(policy#>>'{allocation,alvillas,amount}')::numeric;
  IF value>0 THEN
   expected_count=expected_count+1;
   IF (SELECT count(*) FROM posting p JOIN ledger_account a ON a.organization_id=p.organization_id AND a.id=p.ledger_account_id
     WHERE p.organization_id=org_uuid AND p.transaction_id=t.id AND p.side='DEBIT' AND p.amount=value AND p.bucket='ALVILLAS_EXPENSE'
      AND a.code='ALVILLAS_EXPENSE' AND a.account_type='ALVILLAS_OWN' AND a.normal_side='DEBIT')<>1
   THEN RAISE EXCEPTION 'supplier recognition retains its approved company charge'; END IF;
  END IF;
  value=(policy#>>'{allocation,guest,amount}')::numeric;
  IF value>0 THEN
   expected_count=expected_count+1;
   IF l.reservation_id IS NULL OR (SELECT count(*) FROM posting p JOIN ledger_account a ON a.organization_id=p.organization_id AND a.id=p.ledger_account_id
     WHERE p.organization_id=org_uuid AND p.transaction_id=t.id AND p.side='DEBIT' AND p.amount=value AND p.bucket='GUEST_EXPENSE'
      AND a.code='GUEST_RECEIVABLE' AND a.account_type='CLAIM_OWNERSHIP' AND a.normal_side='DEBIT')<>1
   THEN RAISE EXCEPTION 'supplier recognition retains its approved actual guest charge'; END IF;
  END IF;
  IF expected_count<>(SELECT count(*) FROM posting WHERE organization_id=org_uuid AND transaction_id=t.id) THEN
   RAISE EXCEPTION 'supplier recognition cannot add or omit financial movements'; END IF;
END $$;

CREATE FUNCTION app_assert_supplier_invoice_recognition(org_uuid uuid,recognition_uuid uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE r supplier_invoice_recognition%ROWTYPE; s supplier_invoice_submission%ROWTYPE; i supplier_invoice%ROWTYPE;
 l supplier_invoice_line%ROWTYPE; link supplier_invoice_recognition_line%ROWTYPE; t financial_transaction%ROWTYPE;
 source_line jsonb; policy jsonb; owner_policy jsonb; value numeric; expected_count integer; line_count integer; journal_ids jsonb;
BEGIN
 SELECT * INTO r FROM supplier_invoice_recognition WHERE organization_id=org_uuid AND id=recognition_uuid;
 SELECT * INTO s FROM supplier_invoice_submission WHERE organization_id=org_uuid AND id=r.submission_id;
 SELECT * INTO i FROM supplier_invoice WHERE organization_id=org_uuid AND id=r.invoice_id;
 IF r.id IS NULL OR s.id IS NULL OR i.id IS NULL OR i.state<>'APPROVED' OR i.current_submission_id IS DISTINCT FROM s.id
  OR i.current_revision_id IS DISTINCT FROM s.revision_id OR i.version<>r.invoice_version
 THEN RAISE EXCEPTION 'recognition must retain its actual approved invoice revision'; END IF;
 SELECT count(*) INTO line_count FROM supplier_invoice_line WHERE organization_id=org_uuid AND revision_id=s.revision_id;
 IF line_count=0 OR line_count<>(SELECT count(*) FROM supplier_invoice_recognition_line WHERE organization_id=org_uuid AND recognition_id=r.id)
 THEN RAISE EXCEPTION 'supplier recognition must atomically cover every actual invoice cost line'; END IF;

 IF r.current_period AND NOT EXISTS(SELECT 1 FROM accounting_period_adjustment a JOIN supplier_invoice_recognition_line x
   ON x.organization_id=a.organization_id AND x.id=a.invoice_recognition_line_id WHERE x.organization_id=org_uuid AND x.recognition_id=r.id)
 THEN RAISE EXCEPTION 'current-period invoice recognition must reference an actual closed source'; END IF;
 SELECT jsonb_agg(transaction_id::text ORDER BY transaction_id) INTO journal_ids FROM supplier_invoice_recognition_line WHERE organization_id=org_uuid AND recognition_id=r.id;
 IF NOT EXISTS(SELECT 1 FROM audit_log a WHERE a.organization_id=org_uuid AND a.resource_type='supplier_invoice' AND a.resource_id=i.id
   AND a.actor_id=r.created_by AND a.action='finance.supplier_invoice.recognized' AND a.reason=r.reason
   AND a.after->>'recognitionId'=r.id::text AND a.after->>'submissionId'=s.id::text AND a.after->>'revisionId'=s.revision_id::text
   AND a.after->>'postingDateMode'=CASE WHEN r.current_period THEN 'ADJUST_CLOSED_SOURCES' ELSE 'SOURCE_DATES' END
   AND (a.after->'transactionIds') @> journal_ids AND journal_ids @> (a.after->'transactionIds')
   AND jsonb_array_length(a.after->'transactionIds')=line_count)
 THEN RAISE EXCEPTION 'supplier recognition requires its complete attributed atomic audit'; END IF;
END $$;
CREATE FUNCTION app_supplier_invoice_recognition_complete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_TABLE_NAME='supplier_invoice_recognition' THEN PERFORM app_assert_supplier_invoice_recognition(NEW.organization_id,NEW.id);
 ELSE PERFORM app_assert_supplier_invoice_recognition_line(NEW.organization_id,NEW.id); END IF;
 RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER supplier_invoice_recognition_complete AFTER INSERT ON supplier_invoice_recognition
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app_supplier_invoice_recognition_complete();
CREATE CONSTRAINT TRIGGER supplier_invoice_recognition_line_complete AFTER INSERT ON supplier_invoice_recognition_line
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app_supplier_invoice_recognition_complete();

CREATE FUNCTION app_assert_invoice_period_adjustment(a accounting_period_adjustment) RETURNS void LANGUAGE plpgsql AS $$
DECLARE link supplier_invoice_recognition_line%ROWTYPE; r supplier_invoice_recognition%ROWTYPE; s supplier_invoice_submission%ROWTYPE;
 l supplier_invoice_line%ROWTYPE; t financial_transaction%ROWTYPE; c accounting_period%ROWTYPE; decision accounting_period_event%ROWTYPE;
 policy jsonb; point timestamptz;
BEGIN
 PERFORM pg_advisory_xact_lock_shared(hashtextextended(a.organization_id::text||':accounting-period',0)); point=clock_timestamp();
 SELECT * INTO link FROM supplier_invoice_recognition_line WHERE organization_id=a.organization_id AND id=a.invoice_recognition_line_id;
 SELECT * INTO r FROM supplier_invoice_recognition WHERE organization_id=a.organization_id AND id=link.recognition_id;
 SELECT * INTO s FROM supplier_invoice_submission WHERE organization_id=a.organization_id AND id=r.submission_id;
 SELECT * INTO l FROM supplier_invoice_line WHERE organization_id=a.organization_id AND id=link.invoice_line_id;
 SELECT * INTO t FROM financial_transaction WHERE organization_id=a.organization_id AND id=a.transaction_id;
 SELECT * INTO c FROM accounting_period WHERE organization_id=a.organization_id AND id=a.period_id;
 SELECT * INTO decision FROM accounting_period_event WHERE organization_id=a.organization_id AND period_id=c.id ORDER BY version DESC LIMIT 1;
 SELECT x->'policy' INTO policy FROM jsonb_array_elements(s.snapshot->'lines') x WHERE x->>'id'=l.id::text;
 IF link.id IS NULL OR r.id IS NULL OR s.id IS NULL OR l.id IS NULL OR t.id IS NULL OR c.id IS NULL OR policy IS NULL
  OR NOT r.current_period OR a.expense_id IS NOT NULL OR t.id<>link.transaction_id OR l.revision_id<>s.revision_id
  OR t.created_by<>a.created_by OR r.created_by<>a.created_by OR t.reverses_transaction_id IS NOT NULL OR t.sealed IS DISTINCT FROM false
  OR t.reference IS DISTINCT FROM 'SUPPLIER-INVOICE:'||r.invoice_id||':'||l.id
  OR t.idempotency_key IS DISTINCT FROM 'supplier-invoice:'||s.id||':'||l.id||':recognized'
 THEN RAISE EXCEPTION 'period adjustment requires its actual approved invoice cost and new recognition journal'; END IF;
 IF length(btrim(a.reason)) NOT BETWEEN 6 AND 500 OR a.reason<>r.reason
  OR a.source_occurred_at IS DISTINCT FROM link.source_occurred_at
  OR a.source_occurred_at IS DISTINCT FROM (s.occurred_on::timestamp AT TIME ZONE (policy->>'timezone'))
  OR NOT (c.starts_at<=a.source_occurred_at AND a.source_occurred_at<c.ends_at) OR decision.id IS DISTINCT FROM a.period_event_id
  OR (decision.kind='CLOSE' OR (decision.kind='REOPEN' AND decision.reopens_until<=point)) IS DISTINCT FROM true
 THEN RAISE EXCEPTION 'invoice period adjustment must reference the actual closed source period and decision'; END IF;
 IF t.occurred_at<date_trunc('milliseconds',transaction_timestamp()) OR t.occurred_at>point
  OR date_trunc('month',t.occurred_at AT TIME ZONE c.timezone) IS DISTINCT FROM date_trunc('month',point AT TIME ZONE c.timezone)
  OR NOT app_financial_period_is_open(a.organization_id,t.occurred_at)
 THEN RAISE EXCEPTION 'invoice period adjustment must post in the current open period'; END IF;
END $$;

CREATE FUNCTION app_assert_invoice_period_adjustment_audit(a accounting_period_adjustment) RETURNS void LANGUAGE plpgsql AS $$
DECLARE link supplier_invoice_recognition_line%ROWTYPE; r supplier_invoice_recognition%ROWTYPE; t financial_transaction%ROWTYPE;
BEGIN
 SELECT * INTO link FROM supplier_invoice_recognition_line WHERE organization_id=a.organization_id AND id=a.invoice_recognition_line_id;
 SELECT * INTO r FROM supplier_invoice_recognition WHERE organization_id=a.organization_id AND id=link.recognition_id;
 SELECT * INTO t FROM financial_transaction WHERE organization_id=a.organization_id AND id=a.transaction_id;
 IF link.transaction_id IS DISTINCT FROM t.id OR NOT EXISTS(SELECT 1 FROM audit_log x WHERE x.organization_id=a.organization_id
   AND x.actor_id=a.created_by AND x.resource_type='financial_transaction' AND x.resource_id=t.id AND x.action='finance.period.adjustment_posted' AND x.reason=a.reason
   AND x.after->>'adjustmentId'=a.id::text AND x.after->>'invoiceRecognitionLineId'=link.id::text
   AND x.after->>'invoiceId'=r.invoice_id::text AND x.after->>'submissionId'=r.submission_id::text
   AND x.after->>'transactionId'=t.id::text AND x.after->>'sourcePeriodId'=a.period_id::text AND x.after->>'sourcePeriodEventId'=a.period_event_id::text
   AND (x.after->>'sourceOccurredAt')::timestamptz=a.source_occurred_at AND (x.after->>'postedAt')::timestamptz=t.occurred_at)
  OR NOT EXISTS(SELECT 1 FROM audit_log x WHERE x.organization_id=a.organization_id AND x.actor_id=a.created_by
   AND x.resource_type='supplier_invoice' AND x.resource_id=r.invoice_id AND x.action='finance.supplier_invoice.recognized' AND x.reason=a.reason
   AND x.after->>'recognitionId'=r.id::text AND x.after->>'submissionId'=r.submission_id::text AND x.after->'transactionIds' ? t.id::text)
 THEN RAISE EXCEPTION 'invoice period adjustment requires its complete atomic source and reasoned audits'; END IF;
END $$;

CREATE OR REPLACE FUNCTION app_accounting_period_adjustment_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE source expense%ROWTYPE; submitted expense_submission%ROWTYPE; journal financial_transaction%ROWTYPE;
 calendar accounting_period%ROWTYPE; decision accounting_period_event%ROWTYPE; point timestamptz;
BEGIN
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
END $$;

CREATE OR REPLACE FUNCTION app_accounting_period_adjustment_audit_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE journal financial_transaction%ROWTYPE; source expense%ROWTYPE;
BEGIN
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
END $$;


CREATE FUNCTION app_supplier_invoice_posting_source_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE link_uuid uuid;
BEGIN
 IF NEW.dimensions->>'source' IS DISTINCT FROM 'SUPPLIER_INVOICE' THEN RETURN NEW; END IF;
 SELECT id INTO link_uuid FROM supplier_invoice_recognition_line WHERE organization_id=NEW.organization_id AND transaction_id=NEW.transaction_id
  AND invoice_line_id::text=NEW.dimensions->>'supplier_invoice_line_id';
 IF link_uuid IS NULL THEN RAISE EXCEPTION 'supplier invoice postings require their actual atomic recognized cost source'; END IF;
 PERFORM app_assert_supplier_invoice_recognition_line(NEW.organization_id,link_uuid); RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER supplier_invoice_posting_source_complete AFTER INSERT ON posting
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app_supplier_invoice_posting_source_guard();

COMMIT;
