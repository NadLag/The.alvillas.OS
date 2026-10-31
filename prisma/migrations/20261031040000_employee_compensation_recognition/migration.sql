BEGIN;
-- AlterTable
ALTER TABLE "accounting_period_adjustment" ADD COLUMN     "employee_recognition_line_id" UUID;

-- CreateTable
CREATE TABLE "employee_compensation_recognition" (
    "id" UUID NOT NULL DEFAULT app_uuid_v7(),
    "organization_id" UUID NOT NULL,
    "submission_id" UUID NOT NULL,
    "claim_id" UUID NOT NULL,
    "current_period" BOOLEAN NOT NULL DEFAULT false,
    "idempotency_key" UUID NOT NULL,
    "request_fingerprint" CHAR(64) NOT NULL,
    "reason" VARCHAR(500) NOT NULL,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "employee_compensation_recognition_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "employee_compensation_recognition_line" (
    "id" UUID NOT NULL DEFAULT app_uuid_v7(),
    "organization_id" UUID NOT NULL,
    "recognition_id" UUID NOT NULL,
    "cost_id" UUID NOT NULL,
    "transaction_id" UUID NOT NULL,
    "source_occurred_at" TIMESTAMPTZ(6) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "employee_compensation_recognition_line_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "employee_compensation_recognition_request" (
    "id" UUID NOT NULL DEFAULT app_uuid_v7(),
    "organization_id" UUID NOT NULL,
    "submission_id" UUID NOT NULL,
    "claim_id" UUID NOT NULL,
    "idempotency_key" UUID NOT NULL,
    "request_fingerprint" CHAR(64) NOT NULL,
    "input" JSONB NOT NULL,
    "authorization_cap" JSONB NOT NULL,
    "requested_by" UUID NOT NULL,
    "requested_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "employee_compensation_recognition_request_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "employee_compensation_recognition_outcome" (
    "id" UUID NOT NULL DEFAULT app_uuid_v7(),
    "organization_id" UUID NOT NULL,
    "request_id" UUID NOT NULL,
    "recognition_id" UUID,
    "state" VARCHAR(16) NOT NULL,
    "failure_code" VARCHAR(80),
    "occurred_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "employee_compensation_recognition_outcome_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "employee_recognition_submission_idx" ON "employee_compensation_recognition"("organization_id", "submission_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "employee_recognition_org_id_unique" ON "employee_compensation_recognition"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "employee_recognition_claim_unique" ON "employee_compensation_recognition"("organization_id", "claim_id");

-- CreateIndex
CREATE UNIQUE INDEX "employee_recognition_nonce_unique" ON "employee_compensation_recognition"("organization_id", "idempotency_key");

-- CreateIndex
CREATE INDEX "employee_recognition_line_parent_idx" ON "employee_compensation_recognition_line"("organization_id", "recognition_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "employee_recognition_line_org_id_unique" ON "employee_compensation_recognition_line"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "employee_recognition_line_cost_unique" ON "employee_compensation_recognition_line"("organization_id", "cost_id");

-- CreateIndex
CREATE UNIQUE INDEX "employee_recognition_line_journal_unique" ON "employee_compensation_recognition_line"("organization_id", "transaction_id");

-- CreateIndex
CREATE INDEX "employee_recognition_request_claim_idx" ON "employee_compensation_recognition_request"("organization_id", "claim_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "employee_recognition_request_org_id_unique" ON "employee_compensation_recognition_request"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "employee_recognition_request_nonce_unique" ON "employee_compensation_recognition_request"("organization_id", "idempotency_key");

-- CreateIndex
CREATE INDEX "employee_recognition_outcome_source_idx" ON "employee_compensation_recognition_outcome"("organization_id", "recognition_id");

-- CreateIndex
CREATE UNIQUE INDEX "employee_recognition_outcome_org_id_unique" ON "employee_compensation_recognition_outcome"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "employee_recognition_outcome_request_unique" ON "employee_compensation_recognition_outcome"("organization_id", "request_id");

-- CreateIndex
CREATE UNIQUE INDEX "employee_recognition_adjustment_unique" ON "accounting_period_adjustment"("organization_id", "employee_recognition_line_id");

-- AddForeignKey
ALTER TABLE "accounting_period_adjustment" ADD CONSTRAINT "employee_recognition_adjustment_source_fk" FOREIGN KEY ("organization_id", "employee_recognition_line_id") REFERENCES "employee_compensation_recognition_line"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "employee_compensation_recognition" ADD CONSTRAINT "employee_compensation_recognition_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "employee_compensation_recognition" ADD CONSTRAINT "employee_recognition_submission_fk" FOREIGN KEY ("organization_id", "submission_id") REFERENCES "employee_compensation_submission"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "employee_compensation_recognition" ADD CONSTRAINT "employee_recognition_claim_fk" FOREIGN KEY ("organization_id", "claim_id") REFERENCES "employee_compensation_claim"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "employee_compensation_recognition" ADD CONSTRAINT "employee_recognition_creator_fk" FOREIGN KEY ("organization_id", "created_by") REFERENCES "user_account"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "employee_compensation_recognition_line" ADD CONSTRAINT "employee_compensation_recognition_line_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "employee_compensation_recognition_line" ADD CONSTRAINT "employee_recognition_line_parent_fk" FOREIGN KEY ("organization_id", "recognition_id") REFERENCES "employee_compensation_recognition"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "employee_compensation_recognition_line" ADD CONSTRAINT "employee_recognition_line_cost_fk" FOREIGN KEY ("organization_id", "cost_id") REFERENCES "employee_compensation_cost"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "employee_compensation_recognition_line" ADD CONSTRAINT "employee_recognition_line_journal_fk" FOREIGN KEY ("organization_id", "transaction_id") REFERENCES "financial_transaction"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "employee_compensation_recognition_request" ADD CONSTRAINT "employee_compensation_recognition_request_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "employee_compensation_recognition_request" ADD CONSTRAINT "employee_recognition_request_submission_fk" FOREIGN KEY ("organization_id", "submission_id") REFERENCES "employee_compensation_submission"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "employee_compensation_recognition_request" ADD CONSTRAINT "employee_recognition_request_claim_fk" FOREIGN KEY ("organization_id", "claim_id") REFERENCES "employee_compensation_claim"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "employee_compensation_recognition_request" ADD CONSTRAINT "employee_recognition_request_actor_fk" FOREIGN KEY ("organization_id", "requested_by") REFERENCES "user_account"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "employee_compensation_recognition_outcome" ADD CONSTRAINT "employee_compensation_recognition_outcome_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "employee_compensation_recognition_outcome" ADD CONSTRAINT "employee_recognition_outcome_request_fk" FOREIGN KEY ("organization_id", "request_id") REFERENCES "employee_compensation_recognition_request"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "employee_compensation_recognition_outcome" ADD CONSTRAINT "employee_recognition_outcome_source_fk" FOREIGN KEY ("organization_id", "recognition_id") REFERENCES "employee_compensation_recognition"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;


ALTER TABLE accounting_period_adjustment DROP CONSTRAINT accounting_period_adjustment_one_source;
ALTER TABLE accounting_period_adjustment ADD CONSTRAINT accounting_period_adjustment_one_source CHECK
 ((expense_id IS NOT NULL)::int+(invoice_recognition_line_id IS NOT NULL)::int+(employee_recognition_line_id IS NOT NULL)::int=1);

DO $$ DECLARE tab text; BEGIN
 FOREACH tab IN ARRAY ARRAY['employee_compensation_recognition','employee_compensation_recognition_line','employee_compensation_recognition_request','employee_compensation_recognition_outcome'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',tab);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',tab);
  EXECUTE format('CREATE POLICY %I ON %I USING (organization_id=NULLIF(current_setting(''app.current_organization_id'',true),'''')::uuid) WITH CHECK (organization_id=NULLIF(current_setting(''app.current_organization_id'',true),'''')::uuid)',tab||'_tenant',tab);
  EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION app_prevent_ledger_mutation()',tab||'_immutable',tab);
 END LOOP;
END $$;
ALTER TABLE employee_compensation_recognition ADD CONSTRAINT employee_recognition_fields CHECK(length(btrim(reason)) BETWEEN 6 AND 500 AND request_fingerprint ~ '^[0-9a-f]{64}$');

CREATE FUNCTION app_employee_recognition_admission() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE s employee_compensation_submission%ROWTYPE; c employee_compensation_claim%ROWTYPE;
BEGIN
 SELECT * INTO s FROM employee_compensation_submission WHERE organization_id=NEW.organization_id AND id=NEW.submission_id;
 SELECT * INTO c FROM employee_compensation_claim WHERE organization_id=NEW.organization_id AND id=NEW.claim_id;
 IF s.id IS NULL OR c.id IS NULL OR c.submission_id<>s.id
  OR EXISTS(SELECT 1 FROM employee_compensation_withdrawal WHERE organization_id=s.organization_id AND submission_id=s.id)
  OR EXISTS(SELECT 1 FROM employee_compensation_run_cancellation WHERE organization_id=s.organization_id AND run_id=s.run_id)
  OR NOT EXISTS(SELECT 1 FROM person WHERE organization_id=c.organization_id AND id=c.person_id AND archived_at IS NULL)
  OR (jsonb_array_length(s.snapshot->'stages')>0 AND NOT EXISTS(SELECT 1 FROM approval_request a
   WHERE a.organization_id=s.organization_id AND a.employee_submission_id=s.id AND a.state='APPROVED'
    AND NOT EXISTS(SELECT 1 FROM approval_stage p WHERE p.organization_id=a.organization_id AND p.approval_id=a.id AND p.state<>'APPROVED')))
 THEN RAISE EXCEPTION 'employee recognition requires its actual approved unwithdrawn source and beneficiary'; END IF;
 NEW.created_at=clock_timestamp();RETURN NEW;
END $$;
CREATE TRIGGER employee_recognition_admission BEFORE INSERT ON employee_compensation_recognition FOR EACH ROW EXECUTE FUNCTION app_employee_recognition_admission();

CREATE FUNCTION app_assert_employee_recognition_line(org_uuid uuid,line_uuid uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE r employee_compensation_recognition%ROWTYPE; s employee_compensation_submission%ROWTYPE; c employee_compensation_claim%ROWTYPE;
 l employee_compensation_cost%ROWTYPE; link employee_compensation_recognition_line%ROWTYPE; t financial_transaction%ROWTYPE;
 source_line jsonb; policy jsonb; owner_policy jsonb; value numeric; expected_count integer;
BEGIN
 SELECT * INTO link FROM employee_compensation_recognition_line WHERE organization_id=org_uuid AND id=line_uuid;
 SELECT * INTO r FROM employee_compensation_recognition WHERE organization_id=org_uuid AND id=link.recognition_id;
 SELECT * INTO s FROM employee_compensation_submission WHERE organization_id=org_uuid AND id=r.submission_id;
 SELECT * INTO c FROM employee_compensation_claim WHERE organization_id=org_uuid AND id=r.claim_id;
 SELECT * INTO l FROM employee_compensation_cost WHERE organization_id=org_uuid AND id=link.cost_id;
 SELECT * INTO t FROM financial_transaction WHERE organization_id=org_uuid AND id=link.transaction_id;
 SELECT x INTO source_line FROM jsonb_array_elements(s.snapshot->'costs') x WHERE x->>'runLineId'=l.run_line_id::text;
 policy=source_line->'policy';
 IF link.id IS NULL OR r.id IS NULL OR s.id IS NULL OR c.id IS NULL OR l.id IS NULL OR t.id IS NULL OR policy IS NULL
  OR l.submission_id<>s.id OR l.claim_id<>c.id OR c.submission_id<>s.id OR policy IS DISTINCT FROM l.policy_snapshot
  OR source_line->>'personId' IS DISTINCT FROM c.person_id::text OR source_line->>'completionEventId' IS DISTINCT FROM l.completion_event_id::text
  OR source_line->>'propertyId' IS DISTINCT FROM l.property_id::text OR source_line->>'reservationId' IS DISTINCT FROM l.reservation_id::text
  OR source_line->>'category' IS DISTINCT FROM l.category OR source_line->>'costCenter' IS DISTINCT FROM l.cost_center
  OR source_line->>'note' IS DISTINCT FROM l.note OR source_line->>'timezone' IS DISTINCT FROM l.timezone
  OR (source_line#>>'{amount,amount}')::numeric IS DISTINCT FROM l.amount OR source_line#>>'{amount,currency}' IS DISTINCT FROM l.currency
  OR t.created_by<>r.created_by OR t.reverses_transaction_id IS NOT NULL
  OR t.idempotency_key IS DISTINCT FROM 'employee-compensation:'||s.id||':'||l.id||':recognized'
  OR t.reference IS DISTINCT FROM 'EMPLOYEE-COMPENSATION:'||c.id||':'||l.id
  OR link.source_occurred_at IS DISTINCT FROM (s.cost_on::timestamp AT TIME ZONE l.timezone)
 THEN RAISE EXCEPTION 'employee recognition journal must retain its exact original approved cost source'; END IF;
 IF NOT EXISTS(SELECT 1 FROM accounting_period_adjustment a WHERE a.organization_id=org_uuid AND a.employee_recognition_line_id=link.id) THEN
  IF t.occurred_at IS DISTINCT FROM link.source_occurred_at THEN RAISE EXCEPTION 'employee costs retain their original calendar date'; END IF;
 ELSIF NOT r.current_period OR NOT EXISTS(SELECT 1 FROM accounting_period_adjustment a WHERE a.organization_id=org_uuid AND a.employee_recognition_line_id=link.id
  AND a.transaction_id=t.id AND a.source_occurred_at=link.source_occurred_at AND a.created_by=r.created_by)
 THEN RAISE EXCEPTION 'closed employee costs require their actual attributed adjustment'; END IF;
 IF EXISTS(SELECT 1 FROM posting p WHERE p.organization_id=org_uuid AND p.transaction_id=t.id AND (
  p.currency<>l.currency OR p.dimensions->>'employee_person_id' IS DISTINCT FROM c.person_id::text
  OR p.dimensions->>'employee_compensation_claim_id' IS DISTINCT FROM c.id::text OR p.dimensions->>'employee_compensation_run_id' IS DISTINCT FROM s.run_id::text
  OR p.dimensions->>'employee_compensation_cost_id' IS DISTINCT FROM l.id::text OR p.dimensions->>'employee_compensation_run_line_id' IS DISTINCT FROM l.run_line_id::text
  OR p.dimensions->>'completion_event_id' IS DISTINCT FROM l.completion_event_id::text OR p.dimensions->>'property_id' IS DISTINCT FROM l.property_id::text
  OR p.dimensions->>'reservation_id' IS DISTINCT FROM l.reservation_id::text OR p.dimensions->>'category' IS DISTINCT FROM l.category
  OR p.dimensions->>'cost_center' IS DISTINCT FROM l.cost_center OR p.dimensions->>'source' IS DISTINCT FROM 'EMPLOYEE_COMPENSATION'
  OR p.dimensions ? 'expense_id' OR p.dimensions ? 'supplier_id' OR (p.bucket<>'OWNER_EXPENSE' AND p.dimensions ? 'owner_id')))
  OR (SELECT count(*) FROM posting p WHERE p.organization_id=org_uuid AND p.transaction_id=t.id AND p.side='CREDIT')<>1
  OR (SELECT count(*) FROM posting p JOIN ledger_account a ON a.organization_id=p.organization_id AND a.id=p.ledger_account_id
   WHERE p.organization_id=org_uuid AND p.transaction_id=t.id AND p.side='CREDIT' AND p.amount=l.amount AND p.bucket='EMPLOYEE_COMPENSATION'
   AND a.code='EMPLOYEE_PAYABLE' AND a.account_type='CLAIM_OWNERSHIP' AND a.normal_side='CREDIT')<>1
 THEN RAISE EXCEPTION 'employee recognition credits only the actual beneficiary claim with complete source dimensions'; END IF;
 expected_count=1;
 FOR owner_policy IN SELECT x FROM jsonb_array_elements(policy->'policies') x LOOP
  value=(owner_policy#>>'{allocation,owner,amount}')::numeric;
  IF value>0 THEN
   expected_count=expected_count+1;
   IF (SELECT count(*) FROM posting p JOIN ledger_account a ON a.organization_id=p.organization_id AND a.id=p.ledger_account_id
    WHERE p.organization_id=org_uuid AND p.transaction_id=t.id AND p.side='DEBIT' AND p.amount=value AND p.bucket='OWNER_EXPENSE'
    AND p.dimensions->>'owner_id'=owner_policy->>'ownerId' AND a.code='OWNER_PAYABLE' AND a.account_type='CLAIM_OWNERSHIP' AND a.normal_side='CREDIT')<>1
   THEN RAISE EXCEPTION 'employee recognition retains every approved owner charge to the cent'; END IF;
  END IF;
 END LOOP;
 value=(policy#>>'{allocation,alvillas,amount}')::numeric;
 IF value>0 THEN
  expected_count=expected_count+1;
  IF (SELECT count(*) FROM posting p JOIN ledger_account a ON a.organization_id=p.organization_id AND a.id=p.ledger_account_id
   WHERE p.organization_id=org_uuid AND p.transaction_id=t.id AND p.side='DEBIT' AND p.amount=value AND p.bucket='ALVILLAS_EXPENSE'
    AND a.code='ALVILLAS_EXPENSE' AND a.account_type='ALVILLAS_OWN' AND a.normal_side='DEBIT')<>1
  THEN RAISE EXCEPTION 'employee recognition retains its approved company charge'; END IF;
 END IF;
 value=(policy#>>'{allocation,guest,amount}')::numeric;
 IF value>0 THEN
  expected_count=expected_count+1;
  IF l.reservation_id IS NULL OR (SELECT count(*) FROM posting p JOIN ledger_account a ON a.organization_id=p.organization_id AND a.id=p.ledger_account_id
   WHERE p.organization_id=org_uuid AND p.transaction_id=t.id AND p.side='DEBIT' AND p.amount=value AND p.bucket='GUEST_EXPENSE'
    AND a.code='GUEST_RECEIVABLE' AND a.account_type='CLAIM_OWNERSHIP' AND a.normal_side='DEBIT')<>1
  THEN RAISE EXCEPTION 'employee recognition retains its actual approved guest charge'; END IF;
 END IF;
 IF expected_count<>(SELECT count(*) FROM posting WHERE organization_id=org_uuid AND transaction_id=t.id)
 THEN RAISE EXCEPTION 'employee recognition cannot add or omit financial movements'; END IF;
END $$;

CREATE FUNCTION app_employee_recognition_complete() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE s employee_compensation_submission%ROWTYPE; c employee_compensation_claim%ROWTYPE; n integer; ids jsonb;
BEGIN
 SELECT * INTO s FROM employee_compensation_submission WHERE organization_id=NEW.organization_id AND id=NEW.submission_id;
 SELECT * INTO c FROM employee_compensation_claim WHERE organization_id=NEW.organization_id AND id=NEW.claim_id;
 SELECT count(*) INTO n FROM employee_compensation_cost WHERE organization_id=NEW.organization_id AND claim_id=c.id;
 IF n=0 OR n<>(SELECT count(*) FROM employee_compensation_recognition_line WHERE organization_id=NEW.organization_id AND recognition_id=NEW.id)
  OR EXISTS(SELECT 1 FROM employee_compensation_withdrawal WHERE organization_id=NEW.organization_id AND submission_id=s.id)
 THEN RAISE EXCEPTION 'employee recognition must atomically cover every actual beneficiary cost'; END IF;
 IF NEW.current_period AND NOT EXISTS(SELECT 1 FROM accounting_period_adjustment a JOIN employee_compensation_recognition_line x
  ON x.organization_id=a.organization_id AND x.id=a.employee_recognition_line_id WHERE x.organization_id=NEW.organization_id AND x.recognition_id=NEW.id)
 THEN RAISE EXCEPTION 'current-period employee recognition requires an actual closed source'; END IF;
 SELECT jsonb_agg(transaction_id::text ORDER BY transaction_id) INTO ids FROM employee_compensation_recognition_line WHERE organization_id=NEW.organization_id AND recognition_id=NEW.id;
 IF NOT EXISTS(SELECT 1 FROM audit_log a WHERE a.organization_id=NEW.organization_id AND a.resource_type='employee_compensation_claim' AND a.resource_id=c.id
  AND a.actor_id=NEW.created_by AND a.action='finance.employee_compensation.recognized' AND a.reason=NEW.reason
  AND a.after->>'recognitionId'=NEW.id::text AND a.after->>'submissionId'=s.id::text AND a.after->>'runId'=s.run_id::text
  AND a.after->>'claimId'=c.id::text AND a.after->>'personId'=c.person_id::text
  AND (a.after#>>'{amount,amount}')::numeric=(SELECT sum(amount) FROM employee_compensation_cost WHERE organization_id=NEW.organization_id AND claim_id=c.id)
  AND a.after->>'postingDateMode'=CASE WHEN NEW.current_period THEN 'ADJUST_CLOSED_SOURCES' ELSE 'SOURCE_DATES' END
  AND (a.after->'transactionIds') @> ids AND ids @> (a.after->'transactionIds') AND jsonb_array_length(a.after->'transactionIds')=n)
 THEN RAISE EXCEPTION 'employee recognition requires its complete attributed atomic audit'; END IF;
 RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER employee_recognition_complete AFTER INSERT ON employee_compensation_recognition DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app_employee_recognition_complete();

CREATE FUNCTION app_employee_recognition_line_admission() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM employee_compensation_recognition WHERE organization_id=NEW.organization_id AND id=NEW.recognition_id AND xmin::text=pg_current_xact_id()::text)
  OR NOT EXISTS(SELECT 1 FROM financial_transaction WHERE organization_id=NEW.organization_id AND id=NEW.transaction_id AND xmin::text=pg_current_xact_id()::text AND sealed=false)
 THEN RAISE EXCEPTION 'employee recognition lines and journals must belong to their atomic birth transaction'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER employee_recognition_line_admission BEFORE INSERT ON employee_compensation_recognition_line FOR EACH ROW EXECUTE FUNCTION app_employee_recognition_line_admission();
CREATE FUNCTION app_employee_recognition_line_complete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN PERFORM app_assert_employee_recognition_line(NEW.organization_id,NEW.id);RETURN NEW;END $$;
CREATE CONSTRAINT TRIGGER employee_recognition_line_complete AFTER INSERT ON employee_compensation_recognition_line DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app_employee_recognition_line_complete();
CREATE FUNCTION app_employee_recognition_posting_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE link_uuid uuid;
BEGIN
 IF NEW.dimensions->>'source' IS DISTINCT FROM 'EMPLOYEE_COMPENSATION' AND NEW.bucket<>'EMPLOYEE_COMPENSATION' THEN RETURN NEW; END IF;
 SELECT id INTO link_uuid FROM employee_compensation_recognition_line WHERE organization_id=NEW.organization_id AND transaction_id=NEW.transaction_id AND cost_id::text=NEW.dimensions->>'employee_compensation_cost_id';
 IF link_uuid IS NULL THEN RAISE EXCEPTION 'employee recognition postings require their actual atomic source'; END IF;
 PERFORM app_assert_employee_recognition_line(NEW.organization_id,link_uuid);RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER employee_recognition_posting_complete AFTER INSERT ON posting DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app_employee_recognition_posting_guard();
CREATE FUNCTION app_employee_recognition_prevent_withdrawal() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM employee_compensation_recognition WHERE organization_id=NEW.organization_id AND submission_id=NEW.submission_id)
 THEN RAISE EXCEPTION 'recognized employee costs require appended financial corrections before source release'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER employee_recognition_prevent_withdrawal BEFORE INSERT ON employee_compensation_withdrawal FOR EACH ROW EXECUTE FUNCTION app_employee_recognition_prevent_withdrawal();

ALTER TABLE employee_compensation_recognition_request ADD CONSTRAINT employee_recognition_request_intent CHECK((
 request_fingerprint~'^[0-9a-f]{64}$' AND jsonb_typeof(input)='object' AND jsonb_typeof(authorization_cap)='object'
 AND input->>'id'=submission_id::text AND input->>'claimId'=claim_id::text AND input->>'idempotencyKey'=idempotency_key::text
 AND length(btrim(input->>'reason')) BETWEEN 6 AND 500 AND jsonb_typeof(input->'currentPeriod')='boolean'
 AND authorization_cap->>'organizationId'=organization_id::text AND authorization_cap->>'userAccountId'=requested_by::text
 AND authorization_cap->>'schemaVersion'='1' AND (input-'id'-'claimId'-'currentPeriod'-'idempotencyKey'-'reason')='{}'::jsonb) IS TRUE);
ALTER TABLE employee_compensation_recognition_outcome ADD CONSTRAINT employee_recognition_outcome_kind CHECK((
 (state='SUCCEEDED' AND recognition_id IS NOT NULL AND failure_code IS NULL)
 OR (recognition_id IS NULL AND ((state='DENIED' AND failure_code='ACCESS_DENIED') OR (state='CONFLICT' AND failure_code IN('SOURCE_CHANGED','POLICY_UNAVAILABLE','PERIOD_CLOSED')) OR (state='FAILED' AND failure_code='EXECUTION_UNAVAILABLE')))) IS TRUE);
CREATE FUNCTION app_employee_recognition_request_admission() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM employee_compensation_claim WHERE organization_id=NEW.organization_id AND id=NEW.claim_id AND submission_id=NEW.submission_id)
 THEN RAISE EXCEPTION 'employee recognition request requires its actual submitted beneficiary';END IF;
 NEW.requested_at=clock_timestamp();RETURN NEW;
END $$;
CREATE TRIGGER employee_recognition_request_admission BEFORE INSERT ON employee_compensation_recognition_request FOR EACH ROW EXECUTE FUNCTION app_employee_recognition_request_admission();
CREATE FUNCTION app_employee_recognition_request_complete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF (SELECT count(*) FROM audit_log x WHERE x.organization_id=NEW.organization_id AND x.resource_type='employee_compensation_claim' AND x.resource_id=NEW.claim_id
  AND x.action='finance.employee_compensation.recognition_requested' AND x.actor_id=NEW.requested_by AND x.reason=NEW.input->>'reason' AND x.after->>'requestId'=NEW.id::text)<>1
  OR NOT EXISTS(SELECT 1 FROM outbox_event e WHERE e.organization_id=NEW.organization_id AND e.type='EmployeeCompensationRecognitionRequested'
   AND e.idempotency_key='employee-compensation-recognition-request:'||NEW.id::text||':requested' AND e.payload=jsonb_build_object('requestId',NEW.id::text) AND e.occurred_at=date_trunc('milliseconds',NEW.requested_at))
 THEN RAISE EXCEPTION 'employee recognition request requires its atomic attribution and private worker reference';END IF;RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER employee_recognition_request_complete AFTER INSERT ON employee_compensation_recognition_request DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app_employee_recognition_request_complete();
CREATE FUNCTION app_employee_recognition_outcome_complete() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE q employee_compensation_recognition_request%ROWTYPE; r employee_compensation_recognition%ROWTYPE;
BEGIN
 SELECT * INTO q FROM employee_compensation_recognition_request WHERE organization_id=NEW.organization_id AND id=NEW.request_id;
 IF NEW.state='SUCCEEDED' THEN
  SELECT * INTO r FROM employee_compensation_recognition WHERE organization_id=NEW.organization_id AND id=NEW.recognition_id;
  IF r.id IS NULL OR r.submission_id<>q.submission_id OR r.claim_id<>q.claim_id OR r.created_by<>q.requested_by OR r.idempotency_key<>q.idempotency_key OR r.request_fingerprint<>q.request_fingerprint
  THEN RAISE EXCEPTION 'employee recognition success requires its actual exact intent';END IF;
 END IF;
 IF NOT EXISTS(SELECT 1 FROM audit_log x WHERE x.organization_id=q.organization_id AND x.resource_type='employee_compensation_claim' AND x.resource_id=q.claim_id
  AND x.action='finance.employee_compensation.recognition_completed' AND x.actor_id=q.requested_by AND x.reason=q.input->>'reason'
  AND x.after->>'requestId'=q.id::text AND x.after->>'outcomeId'=NEW.id::text AND x.after->>'state'=NEW.state
  AND x.after->>'recognitionId' IS NOT DISTINCT FROM NEW.recognition_id::text AND x.after->>'failureCode' IS NOT DISTINCT FROM NEW.failure_code)
 THEN RAISE EXCEPTION 'employee recognition outcome requires its actual attributed audit';END IF;RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER employee_recognition_outcome_complete AFTER INSERT ON employee_compensation_recognition_outcome DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app_employee_recognition_outcome_complete();
CREATE FUNCTION app_employee_recognition_outbox_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE q employee_compensation_recognition_request%ROWTYPE;
BEGIN
 IF TG_OP<>'INSERT' AND OLD.type='EmployeeCompensationRecognitionRequested' THEN
  IF TG_OP='DELETE' OR ROW(NEW.id,NEW.organization_id,NEW.type,NEW.payload,NEW.idempotency_key,NEW.occurred_at,NEW.created_at)
   IS DISTINCT FROM ROW(OLD.id,OLD.organization_id,OLD.type,OLD.payload,OLD.idempotency_key,OLD.occurred_at,OLD.created_at)
  THEN RAISE EXCEPTION 'employee recognition worker references are immutable';END IF;
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD;END IF;
 IF NEW.type='EmployeeCompensationRecognitionRequested' THEN
  SELECT * INTO q FROM employee_compensation_recognition_request WHERE organization_id=NEW.organization_id AND id::text=NEW.payload->>'requestId';
  IF q.id IS NULL OR NEW.payload<>jsonb_build_object('requestId',q.id::text) OR NEW.idempotency_key<>'employee-compensation-recognition-request:'||q.id::text||':requested'
   OR NEW.occurred_at<>date_trunc('milliseconds',q.requested_at)
  THEN RAISE EXCEPTION 'employee recognition worker reference requires its actual private request';END IF;
 END IF;RETURN NEW;
END $$;
CREATE TRIGGER employee_recognition_outbox_guard BEFORE INSERT OR UPDATE OR DELETE ON outbox_event FOR EACH ROW EXECUTE FUNCTION app_employee_recognition_outbox_guard();

CREATE FUNCTION app_assert_employee_period_adjustment(a accounting_period_adjustment) RETURNS void LANGUAGE plpgsql AS $$
DECLARE link employee_compensation_recognition_line%ROWTYPE; r employee_compensation_recognition%ROWTYPE; s employee_compensation_submission%ROWTYPE;
 l employee_compensation_cost%ROWTYPE; t financial_transaction%ROWTYPE; c accounting_period%ROWTYPE; decision accounting_period_event%ROWTYPE;
 policy jsonb; point timestamptz;
BEGIN
 PERFORM pg_advisory_xact_lock_shared(hashtextextended(a.organization_id::text||':accounting-period',0)); point=clock_timestamp();
 SELECT * INTO link FROM employee_compensation_recognition_line WHERE organization_id=a.organization_id AND id=a.employee_recognition_line_id;
 SELECT * INTO r FROM employee_compensation_recognition WHERE organization_id=a.organization_id AND id=link.recognition_id;
 SELECT * INTO s FROM employee_compensation_submission WHERE organization_id=a.organization_id AND id=r.submission_id;
 SELECT * INTO l FROM employee_compensation_cost WHERE organization_id=a.organization_id AND id=link.cost_id;
 SELECT * INTO t FROM financial_transaction WHERE organization_id=a.organization_id AND id=a.transaction_id;
 SELECT * INTO c FROM accounting_period WHERE organization_id=a.organization_id AND id=a.period_id;
 SELECT * INTO decision FROM accounting_period_event WHERE organization_id=a.organization_id AND period_id=c.id ORDER BY version DESC LIMIT 1;
 policy=l.policy_snapshot;
 IF link.id IS NULL OR r.id IS NULL OR s.id IS NULL OR l.id IS NULL OR t.id IS NULL OR c.id IS NULL OR policy IS NULL
  OR NOT r.current_period OR (a.expense_id IS NOT NULL OR a.invoice_recognition_line_id IS NOT NULL) OR t.id<>link.transaction_id OR l.submission_id<>s.id OR l.claim_id<>r.claim_id
  OR t.created_by<>a.created_by OR r.created_by<>a.created_by OR t.reverses_transaction_id IS NOT NULL OR t.sealed IS DISTINCT FROM false
  OR t.reference IS DISTINCT FROM 'EMPLOYEE-COMPENSATION:'||r.claim_id||':'||l.id
  OR t.idempotency_key IS DISTINCT FROM 'employee-compensation:'||s.id||':'||l.id||':recognized'
 THEN RAISE EXCEPTION 'period adjustment requires its actual approved invoice cost and new recognition journal'; END IF;
 IF length(btrim(a.reason)) NOT BETWEEN 6 AND 500 OR a.reason<>r.reason
  OR a.source_occurred_at IS DISTINCT FROM link.source_occurred_at
  OR a.source_occurred_at IS DISTINCT FROM (s.cost_on::timestamp AT TIME ZONE (policy->>'timezone'))
  OR NOT (c.starts_at<=a.source_occurred_at AND a.source_occurred_at<c.ends_at) OR decision.id IS DISTINCT FROM a.period_event_id
  OR (decision.kind='CLOSE' OR (decision.kind='REOPEN' AND decision.reopens_until<=point)) IS DISTINCT FROM true
 THEN RAISE EXCEPTION 'invoice period adjustment must reference the actual closed source period and decision'; END IF;
 IF t.occurred_at<date_trunc('milliseconds',transaction_timestamp()) OR t.occurred_at>point
  OR date_trunc('month',t.occurred_at AT TIME ZONE c.timezone) IS DISTINCT FROM date_trunc('month',point AT TIME ZONE c.timezone)
  OR NOT app_financial_period_is_open(a.organization_id,t.occurred_at)
 THEN RAISE EXCEPTION 'invoice period adjustment must post in the current open period'; END IF;
END $$;
CREATE FUNCTION app_assert_employee_period_adjustment_audit(a accounting_period_adjustment) RETURNS void LANGUAGE plpgsql AS $$
DECLARE link employee_compensation_recognition_line%ROWTYPE; r employee_compensation_recognition%ROWTYPE; t financial_transaction%ROWTYPE;
BEGIN
 SELECT * INTO link FROM employee_compensation_recognition_line WHERE organization_id=a.organization_id AND id=a.employee_recognition_line_id;
 SELECT * INTO r FROM employee_compensation_recognition WHERE organization_id=a.organization_id AND id=link.recognition_id;
 SELECT * INTO t FROM financial_transaction WHERE organization_id=a.organization_id AND id=a.transaction_id;
 IF link.transaction_id IS DISTINCT FROM t.id OR NOT EXISTS(SELECT 1 FROM audit_log x WHERE x.organization_id=a.organization_id
   AND x.actor_id=a.created_by AND x.resource_type='financial_transaction' AND x.resource_id=t.id AND x.action='finance.period.adjustment_posted' AND x.reason=a.reason
   AND x.after->>'adjustmentId'=a.id::text AND x.after->>'employeeRecognitionLineId'=link.id::text
   AND x.after->>'claimId'=r.claim_id::text AND x.after->>'submissionId'=r.submission_id::text
   AND x.after->>'transactionId'=t.id::text AND x.after->>'sourcePeriodId'=a.period_id::text AND x.after->>'sourcePeriodEventId'=a.period_event_id::text
   AND (x.after->>'sourceOccurredAt')::timestamptz=a.source_occurred_at AND (x.after->>'postedAt')::timestamptz=t.occurred_at)
  OR NOT EXISTS(SELECT 1 FROM audit_log x WHERE x.organization_id=a.organization_id AND x.actor_id=a.created_by
   AND x.resource_type='employee_compensation_claim' AND x.resource_id=r.claim_id AND x.action='finance.employee_compensation.recognized' AND x.reason=a.reason
   AND x.after->>'recognitionId'=r.id::text AND x.after->>'submissionId'=r.submission_id::text AND x.after->'transactionIds' ? t.id::text)
 THEN RAISE EXCEPTION 'invoice period adjustment requires its complete atomic source and reasoned audits'; END IF;
END $$;
CREATE OR REPLACE FUNCTION app_accounting_period_adjustment_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE source expense%ROWTYPE; submitted expense_submission%ROWTYPE; journal financial_transaction%ROWTYPE;
 calendar accounting_period%ROWTYPE; decision accounting_period_event%ROWTYPE; point timestamptz;
BEGIN
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
END $$;
CREATE OR REPLACE FUNCTION app_accounting_period_adjustment_audit_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE journal financial_transaction%ROWTYPE; source expense%ROWTYPE;
BEGIN
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
END $$;
COMMIT;
