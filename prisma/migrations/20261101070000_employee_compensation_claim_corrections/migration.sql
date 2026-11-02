BEGIN;
-- CreateTable
CREATE TABLE "employee_compensation_correction" (
    "id" UUID NOT NULL DEFAULT app_uuid_v7(),
    "organization_id" UUID NOT NULL,
    "submission_id" UUID NOT NULL,
    "claim_id" UUID NOT NULL,
    "recognition_id" UUID NOT NULL,
    "idempotency_key" UUID NOT NULL,
    "request_fingerprint" CHAR(64) NOT NULL,
    "reason" VARCHAR(500) NOT NULL,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "employee_compensation_correction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "employee_compensation_correction_line" (
    "id" UUID NOT NULL DEFAULT app_uuid_v7(),
    "organization_id" UUID NOT NULL,
    "correction_id" UUID NOT NULL,
    "cost_id" UUID NOT NULL,
    "recognition_line_id" UUID NOT NULL,
    "original_transaction_id" UUID NOT NULL,
    "reversal_transaction_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "employee_compensation_correction_line_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "employee_correction_submission_idx" ON "employee_compensation_correction"("organization_id", "submission_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "employee_correction_org_id_unique" ON "employee_compensation_correction"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "employee_correction_claim_unique" ON "employee_compensation_correction"("organization_id", "claim_id");

-- CreateIndex
CREATE UNIQUE INDEX "employee_correction_recognition_unique" ON "employee_compensation_correction"("organization_id", "recognition_id");

-- CreateIndex
CREATE UNIQUE INDEX "employee_correction_nonce_unique" ON "employee_compensation_correction"("organization_id", "idempotency_key");

-- CreateIndex
CREATE INDEX "employee_correction_line_parent_idx" ON "employee_compensation_correction_line"("organization_id", "correction_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "employee_correction_line_org_id_unique" ON "employee_compensation_correction_line"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "employee_correction_line_cost_unique" ON "employee_compensation_correction_line"("organization_id", "cost_id");

-- CreateIndex
CREATE UNIQUE INDEX "employee_correction_line_source_unique" ON "employee_compensation_correction_line"("organization_id", "recognition_line_id");

-- CreateIndex
CREATE UNIQUE INDEX "employee_correction_line_original_unique" ON "employee_compensation_correction_line"("organization_id", "original_transaction_id");

-- CreateIndex
CREATE UNIQUE INDEX "employee_correction_line_opposite_unique" ON "employee_compensation_correction_line"("organization_id", "reversal_transaction_id");

-- AddForeignKey
ALTER TABLE "employee_compensation_correction" ADD CONSTRAINT "employee_compensation_correction_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "employee_compensation_correction" ADD CONSTRAINT "employee_correction_submission_fk" FOREIGN KEY ("organization_id", "submission_id") REFERENCES "employee_compensation_submission"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "employee_compensation_correction" ADD CONSTRAINT "employee_correction_claim_fk" FOREIGN KEY ("organization_id", "claim_id") REFERENCES "employee_compensation_claim"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "employee_compensation_correction" ADD CONSTRAINT "employee_correction_recognition_fk" FOREIGN KEY ("organization_id", "recognition_id") REFERENCES "employee_compensation_recognition"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "employee_compensation_correction" ADD CONSTRAINT "employee_correction_creator_fk" FOREIGN KEY ("organization_id", "created_by") REFERENCES "user_account"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "employee_compensation_correction_line" ADD CONSTRAINT "employee_compensation_correction_line_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "employee_compensation_correction_line" ADD CONSTRAINT "employee_correction_line_parent_fk" FOREIGN KEY ("organization_id", "correction_id") REFERENCES "employee_compensation_correction"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "employee_compensation_correction_line" ADD CONSTRAINT "employee_correction_line_cost_fk" FOREIGN KEY ("organization_id", "cost_id") REFERENCES "employee_compensation_cost"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "employee_compensation_correction_line" ADD CONSTRAINT "employee_correction_line_recognition_fk" FOREIGN KEY ("organization_id", "recognition_line_id") REFERENCES "employee_compensation_recognition_line"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "employee_compensation_correction_line" ADD CONSTRAINT "employee_correction_line_original_fk" FOREIGN KEY ("organization_id", "original_transaction_id") REFERENCES "financial_transaction"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "employee_compensation_correction_line" ADD CONSTRAINT "employee_correction_line_opposite_fk" FOREIGN KEY ("organization_id", "reversal_transaction_id") REFERENCES "financial_transaction"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;


ALTER TABLE employee_compensation_correction ADD CONSTRAINT employee_correction_fields CHECK
 (length(btrim(reason)) BETWEEN 6 AND 500 AND request_fingerprint ~ '^[0-9a-f]{64}$');
ALTER TABLE employee_compensation_correction_line ADD CONSTRAINT employee_correction_opposite_distinct CHECK
 (original_transaction_id <> reversal_transaction_id);

DO $$ DECLARE tab text; BEGIN
 FOREACH tab IN ARRAY ARRAY['employee_compensation_correction','employee_compensation_correction_line'] LOOP
  EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION app_prevent_ledger_mutation()',tab||'_immutable',tab);
 END LOOP;
END $$;
ALTER TABLE employee_compensation_correction ENABLE ROW LEVEL SECURITY;
ALTER TABLE employee_compensation_correction FORCE ROW LEVEL SECURITY;
ALTER TABLE employee_compensation_correction_line ENABLE ROW LEVEL SECURITY;
ALTER TABLE employee_compensation_correction_line FORCE ROW LEVEL SECURITY;
CREATE POLICY employee_compensation_correction_tenant_isolation ON employee_compensation_correction
 USING(organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid)
 WITH CHECK(organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid);
CREATE POLICY employee_compensation_correction_line_tenant_isolation ON employee_compensation_correction_line
 USING(organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid)
 WITH CHECK(organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid);

CREATE FUNCTION app_employee_correction_admission() RETURNS trigger LANGUAGE plpgsql SET search_path TO 'public','pg_temp' AS $$
DECLARE r employee_compensation_recognition%ROWTYPE;
BEGIN
 SELECT * INTO r FROM employee_compensation_recognition WHERE organization_id=NEW.organization_id AND id=NEW.recognition_id;
 IF r.id IS NULL OR r.claim_id<>NEW.claim_id OR r.submission_id<>NEW.submission_id
 THEN RAISE EXCEPTION 'employee correction requires its actual original recognized beneficiary';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(NEW.organization_id::text||':employee-submission:'||NEW.submission_id::text,0));
 NEW.created_at=clock_timestamp();RETURN NEW;
END $$;
CREATE TRIGGER employee_correction_admission BEFORE INSERT ON employee_compensation_correction FOR EACH ROW EXECUTE FUNCTION app_employee_correction_admission();

CREATE FUNCTION app_employee_correction_line_admission() RETURNS trigger LANGUAGE plpgsql SET search_path TO 'public','pg_temp' AS $$
DECLARE q employee_compensation_correction%ROWTYPE; q_xid text; l employee_compensation_recognition_line%ROWTYPE; t financial_transaction%ROWTYPE; t_xid text;
BEGIN
 SELECT * INTO q FROM employee_compensation_correction WHERE organization_id=NEW.organization_id AND id=NEW.correction_id;
 SELECT xmin::text INTO q_xid FROM employee_compensation_correction WHERE organization_id=NEW.organization_id AND id=NEW.correction_id;
 SELECT * INTO l FROM employee_compensation_recognition_line WHERE organization_id=NEW.organization_id AND id=NEW.recognition_line_id;
 SELECT * INTO t FROM financial_transaction WHERE organization_id=NEW.organization_id AND id=NEW.reversal_transaction_id;
 SELECT xmin::text INTO t_xid FROM financial_transaction WHERE organization_id=NEW.organization_id AND id=NEW.reversal_transaction_id;
 IF q.id IS NULL OR l.id IS NULL OR t.id IS NULL OR q_xid::bigint<>mod(pg_current_xact_id()::text::numeric,4294967296)::bigint
  OR t_xid::bigint<>mod(pg_current_xact_id()::text::numeric,4294967296)::bigint
  OR l.recognition_id<>q.recognition_id OR l.cost_id<>NEW.cost_id OR l.transaction_id<>NEW.original_transaction_id
  OR t.reverses_transaction_id IS DISTINCT FROM NEW.original_transaction_id OR t.created_by IS DISTINCT FROM q.created_by
 THEN RAISE EXCEPTION 'employee correction lines require their original recognized cost and atomic exact opposite';END IF;
 NEW.created_at=clock_timestamp();RETURN NEW;
END $$;
CREATE TRIGGER employee_correction_line_admission BEFORE INSERT ON employee_compensation_correction_line FOR EACH ROW EXECUTE FUNCTION app_employee_correction_line_admission();

CREATE FUNCTION app_assert_employee_correction(org_uuid uuid,correction_uuid uuid) RETURNS void LANGUAGE plpgsql SET search_path TO 'public','pg_temp' AS $$
DECLARE q employee_compensation_correction%ROWTYPE; r employee_compensation_recognition%ROWTYPE; s employee_compensation_submission%ROWTYPE;
 claim employee_compensation_claim%ROWTYPE; original_ids jsonb; reversal_ids jsonb; original_count bigint; actual_count bigint;
BEGIN
 SELECT * INTO q FROM employee_compensation_correction WHERE organization_id=org_uuid AND id=correction_uuid;
 SELECT * INTO r FROM employee_compensation_recognition WHERE organization_id=org_uuid AND id=q.recognition_id;
 SELECT * INTO s FROM employee_compensation_submission WHERE organization_id=org_uuid AND id=q.submission_id;
 SELECT * INTO claim FROM employee_compensation_claim WHERE organization_id=org_uuid AND id=q.claim_id;
 IF q.id IS NULL OR r.id IS NULL OR s.id IS NULL OR claim.id IS NULL OR r.claim_id<>claim.id OR r.submission_id<>s.id OR claim.submission_id<>s.id
  OR EXISTS(SELECT 1 FROM employee_compensation_withdrawal w WHERE w.organization_id=org_uuid AND w.submission_id=s.id)
  OR EXISTS(SELECT 1 FROM employee_compensation_run_cancellation c WHERE c.organization_id=org_uuid AND c.run_id=s.run_id)
  OR EXISTS(SELECT 1 FROM approval_request a WHERE a.organization_id=org_uuid AND a.employee_submission_id=s.id AND a.state<>'APPROVED')
  OR EXISTS(SELECT 1 FROM approval_stage stage JOIN approval_request a ON a.organization_id=stage.organization_id AND a.id=stage.approval_id WHERE a.organization_id=org_uuid AND a.employee_submission_id=s.id AND stage.state<>'APPROVED')
 THEN RAISE EXCEPTION 'employee correction requires its complete original approved and recognized claim';END IF;
 SELECT count(*) INTO original_count FROM employee_compensation_recognition_line WHERE organization_id=org_uuid AND recognition_id=r.id;
 SELECT count(*),jsonb_agg(original_transaction_id::text ORDER BY cost_id),jsonb_agg(reversal_transaction_id::text ORDER BY cost_id)
  INTO actual_count,original_ids,reversal_ids FROM employee_compensation_correction_line WHERE organization_id=org_uuid AND correction_id=q.id;
 IF original_count=0 OR actual_count<>original_count OR original_count<>(SELECT count(*) FROM employee_compensation_cost WHERE organization_id=org_uuid AND claim_id=claim.id)
 THEN RAISE EXCEPTION 'employee correction must oppose every original beneficiary cost exactly once';END IF;
 IF EXISTS(SELECT 1 FROM employee_compensation_correction_line link
  LEFT JOIN employee_compensation_recognition_line source ON source.organization_id=link.organization_id AND source.id=link.recognition_line_id
  LEFT JOIN employee_compensation_cost cost ON cost.organization_id=link.organization_id AND cost.id=link.cost_id
  LEFT JOIN financial_transaction original ON original.organization_id=link.organization_id AND original.id=link.original_transaction_id
  LEFT JOIN financial_transaction opposite ON opposite.organization_id=link.organization_id AND opposite.id=link.reversal_transaction_id
  WHERE link.organization_id=org_uuid AND link.correction_id=q.id AND (source.id IS NULL OR cost.id IS NULL OR original.id IS NULL OR opposite.id IS NULL
   OR source.recognition_id<>r.id OR source.cost_id<>cost.id OR source.transaction_id<>original.id OR cost.claim_id<>claim.id OR cost.submission_id<>s.id
   OR NOT original.sealed OR original.reverses_transaction_id IS NOT NULL OR opposite.reverses_transaction_id IS DISTINCT FROM original.id
   OR opposite.created_by IS DISTINCT FROM q.created_by OR opposite.description IS DISTINCT FROM q.reason
   OR opposite.reference IS DISTINCT FROM original.reference||':VOID' OR opposite.idempotency_key IS DISTINCT FROM original.idempotency_key||':void'
   OR opposite.occurred_at<date_trunc('milliseconds',transaction_timestamp()) OR opposite.occurred_at>clock_timestamp()
   OR NOT app_financial_period_is_open(org_uuid,opposite.occurred_at)))
 THEN RAISE EXCEPTION 'employee correction must retain its exact original approved journals and current open-period opposites';END IF;
 IF EXISTS(SELECT 1 FROM financial_transaction payment JOIN posting p ON p.organization_id=payment.organization_id AND p.transaction_id=payment.id
  WHERE payment.organization_id=org_uuid AND payment.reverses_transaction_id IS NULL AND p.dimensions->>'employee_compensation_claim_id'=claim.id::text
   AND (p.bucket IN('EMPLOYEE_PAYMENT','COMPENSATION_OFFSET') OR p.dimensions->>'source' IN('EMPLOYEE_PAYMENT','EMPLOYEE_COMPENSATION_OFFSET'))
   AND NOT EXISTS(SELECT 1 FROM financial_transaction opposite WHERE opposite.organization_id=org_uuid AND opposite.reverses_transaction_id=payment.id))
 THEN RAISE EXCEPTION 'employee claim correction requires all actual payments and wallet offsets to be reversed first';END IF;
 IF (SELECT COALESCE(sum(CASE WHEN p.side='CREDIT' THEN p.amount ELSE -p.amount END),0) FROM posting p JOIN ledger_account a ON a.organization_id=p.organization_id AND a.id=p.ledger_account_id
  WHERE p.organization_id=org_uuid AND a.code='EMPLOYEE_PAYABLE' AND p.dimensions->>'employee_compensation_claim_id'=claim.id::text)<>0
 THEN RAISE EXCEPTION 'employee corrected claim must have zero outstanding derived from its actual movements';END IF;
 IF (SELECT count(*) FROM audit_log a WHERE a.organization_id=org_uuid AND a.action='finance.employee_compensation.corrected' AND a.resource_type='employee_compensation_claim'
  AND a.resource_id=claim.id AND a.actor_id=q.created_by AND a.reason=q.reason AND a.after->>'correctionId'=q.id::text
  AND a.after->>'submissionId'=s.id::text AND a.after->>'runId'=s.run_id::text AND a.after->>'recognitionId'=r.id::text
  AND a.after->>'claimId'=claim.id::text AND a.after->>'personId'=claim.person_id::text
  AND a.after->'originalTransactionIds'=original_ids AND a.after->'reversalTransactionIds'=reversal_ids
  AND (a.after#>>'{amount,amount}')::numeric=(SELECT sum(amount) FROM employee_compensation_cost WHERE organization_id=org_uuid AND claim_id=claim.id)
  AND a.after#>>'{amount,currency}'=(SELECT currency FROM employee_compensation_run WHERE organization_id=org_uuid AND id=s.run_id))<>1
 THEN RAISE EXCEPTION 'employee correction requires its exact attributed immutable financial receipt';END IF;
END $$;

CREATE FUNCTION app_employee_correction_complete() RETURNS trigger LANGUAGE plpgsql SET search_path TO 'public','pg_temp' AS $$
BEGIN
 IF TG_TABLE_NAME='employee_compensation_correction' THEN PERFORM app_assert_employee_correction(NEW.organization_id,NEW.id);
 ELSE PERFORM app_assert_employee_correction(NEW.organization_id,NEW.correction_id);END IF;RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER employee_correction_complete AFTER INSERT ON employee_compensation_correction DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app_employee_correction_complete();
CREATE CONSTRAINT TRIGGER employee_correction_line_complete AFTER INSERT ON employee_compensation_correction_line DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app_employee_correction_complete();

CREATE FUNCTION app_employee_correction_audit_guard() RETURNS trigger LANGUAGE plpgsql SET search_path TO 'public','pg_temp' AS $$
DECLARE q employee_compensation_correction%ROWTYPE; birth text;
BEGIN
 IF NEW.action<>'finance.employee_compensation.corrected' THEN RETURN NEW;END IF;
 SELECT * INTO q FROM employee_compensation_correction WHERE organization_id=NEW.organization_id AND id::text=NEW.after->>'correctionId';
 SELECT xmin::text INTO birth FROM employee_compensation_correction WHERE organization_id=NEW.organization_id AND id=q.id;
 IF q.id IS NULL OR birth::bigint<>mod(pg_current_xact_id()::text::numeric,4294967296)::bigint OR NEW.actor_id IS DISTINCT FROM q.created_by
  OR NEW.reason IS DISTINCT FROM q.reason OR NEW.resource_type IS DISTINCT FROM 'employee_compensation_claim' OR NEW.resource_id IS DISTINCT FROM q.claim_id
 THEN RAISE EXCEPTION 'employee correction audit requires its actual atomic original correction';END IF;RETURN NEW;
END $$;
CREATE TRIGGER employee_correction_audit_guard BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION app_employee_correction_audit_guard();

CREATE OR REPLACE FUNCTION public.app_employee_recognition_posting_guard()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE link_uuid uuid; correction_uuid uuid;
BEGIN
 IF EXISTS(SELECT 1 FROM financial_transaction t JOIN employee_compensation_recognition_line l ON l.organization_id=t.organization_id AND l.transaction_id=t.reverses_transaction_id WHERE t.organization_id=NEW.organization_id AND t.id=NEW.transaction_id) THEN
  SELECT link.correction_id INTO correction_uuid FROM employee_compensation_correction_line link
   WHERE link.organization_id=NEW.organization_id AND link.reversal_transaction_id=NEW.transaction_id AND link.cost_id::text=NEW.dimensions->>'employee_compensation_cost_id';
  IF correction_uuid IS NULL THEN RAISE EXCEPTION 'employee recognition opposites require their actual typed original correction';END IF;
  PERFORM app_assert_employee_correction(NEW.organization_id,correction_uuid);RETURN NEW;
 END IF;
 IF NEW.dimensions->>'source' IN ('EMPLOYEE_PAYMENT','EMPLOYEE_COMPENSATION_OFFSET') OR NEW.bucket IN ('EMPLOYEE_PAYMENT','COMPENSATION_OFFSET') THEN
  PERFORM app_assert_employee_settlement(NEW.organization_id,NEW.transaction_id);RETURN NEW;END IF;
 IF NEW.dimensions->>'source' IS DISTINCT FROM 'EMPLOYEE_COMPENSATION' AND NEW.bucket IS DISTINCT FROM 'EMPLOYEE_COMPENSATION'
  AND NOT COALESCE(NEW.dimensions ? 'employee_compensation_claim_id',false)
  AND NOT EXISTS(SELECT 1 FROM ledger_account a WHERE a.organization_id=NEW.organization_id AND a.id=NEW.ledger_account_id AND a.code='EMPLOYEE_PAYABLE') THEN RETURN NEW;END IF;
 SELECT id INTO link_uuid FROM employee_compensation_recognition_line WHERE organization_id=NEW.organization_id AND transaction_id=NEW.transaction_id AND cost_id::text=NEW.dimensions->>'employee_compensation_cost_id';
 IF link_uuid IS NULL THEN RAISE EXCEPTION 'employee recognition postings require their actual atomic source';END IF;
 PERFORM app_assert_employee_recognition_line(NEW.organization_id,link_uuid);RETURN NEW;
END $function$;
CREATE OR REPLACE FUNCTION public.app_employee_cost_admission()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE s employee_compensation_submission%ROWTYPE; c employee_compensation_claim%ROWTYPE; l employee_compensation_run_line%ROWTYPE; expected jsonb; source_xid text;
BEGIN
 SELECT * INTO s FROM employee_compensation_submission WHERE organization_id=NEW.organization_id AND id=NEW.submission_id;
 SELECT xmin::text INTO source_xid FROM employee_compensation_submission WHERE organization_id=NEW.organization_id AND id=NEW.submission_id;
 IF s.id IS NULL OR source_xid::bigint<>mod(pg_current_xact_id()::text::numeric,4294967296)::bigint
 THEN RAISE EXCEPTION 'employee claim sources are admitted with their original submission only'; END IF;
 IF TG_TABLE_NAME='employee_compensation_claim' THEN
  IF NOT EXISTS(SELECT 1 FROM employee_compensation_run_line x WHERE x.organization_id=NEW.organization_id AND x.run_id=s.run_id AND x.person_id=NEW.person_id AND x.amount>0)
  THEN RAISE EXCEPTION 'employee claim requires its actual positive-work beneficiary'; END IF;
 ELSE
  SELECT * INTO c FROM employee_compensation_claim WHERE organization_id=NEW.organization_id AND id=NEW.claim_id;
  SELECT * INTO l FROM employee_compensation_run_line WHERE organization_id=NEW.organization_id AND id=NEW.run_line_id;
  SELECT value INTO expected FROM jsonb_array_elements(s.snapshot->'costs') WHERE value->>'runLineId'=NEW.run_line_id::text;
  IF l.earning_kind='PERCENTAGE' THEN PERFORM app_assert_employee_percentage_cost(NEW,s,c,l,expected);NEW.created_at=clock_timestamp();RETURN NEW;END IF;

  IF l.earning_kind='PER_HOUR' THEN PERFORM app_assert_employee_hourly_witnesses(l.organization_id,l.id);IF expected->>'earningKind' IS DISTINCT FROM 'PER_HOUR' OR NEW.policy_snapshot->>'earningKind' IS DISTINCT FROM 'PER_HOUR' OR NEW.policy_snapshot->>'workTimeEvidenceId' IS DISTINCT FROM l.work_time_evidence_id::text OR NEW.policy_snapshot->>'workTimeDecisionId' IS DISTINCT FROM l.work_time_decision_id::text THEN RAISE EXCEPTION 'hourly costs require their actual complete original work evidence and validation';END IF;END IF;
  IF l.earning_kind='PER_MONTH' THEN
   IF expected->>'earningKind' IS DISTINCT FROM 'PER_MONTH' OR expected->>'assignmentId' IS DISTINCT FROM l.assignment_id::text OR expected->>'earningPeriodKey' IS DISTINCT FROM l.earning_period_key
    OR expected->>'taskId' IS DISTINCT FROM l.task_id::text OR NOT(expected ? 'completionEventId') OR NOT(expected ? 'propertyId') OR NOT(expected ? 'taskId')
    OR NEW.policy_snapshot->>'schemaVersion' IS DISTINCT FROM '1' OR NEW.policy_snapshot->>'sourceKind' IS DISTINCT FROM 'employee_compensation_run_line'
    OR NEW.policy_snapshot->>'earningKind' IS DISTINCT FROM 'PER_MONTH' OR NEW.policy_snapshot->>'assignmentId' IS DISTINCT FROM l.assignment_id::text OR NEW.policy_snapshot->>'earningPeriodKey' IS DISTINCT FROM l.earning_period_key
    OR NEW.policy_snapshot->>'runId' IS DISTINCT FROM l.run_id::text OR NEW.policy_snapshot->>'runLineId' IS DISTINCT FROM l.id::text OR NEW.policy_snapshot->>'personId' IS DISTINCT FROM l.person_id::text
    OR NEW.policy_snapshot->>'completionEventId' IS NOT NULL OR NOT(NEW.policy_snapshot ? 'completionEventId') OR NEW.completion_event_id IS NOT NULL
   THEN RAISE EXCEPTION 'monthly costs require their complete canonical original contractual source';END IF;
   IF NEW.property_id IS NULL AND(
     NEW.reservation_id IS NOT NULL OR NEW.policy_snapshot->>'propertyId' IS NOT NULL OR NEW.policy_snapshot->>'reservationId' IS NOT NULL
     OR NOT(NEW.policy_snapshot ? 'propertyId') OR NOT(NEW.policy_snapshot ? 'reservationId')
     OR(NEW.policy_snapshot#>>'{allocation,owner,amount}')::numeric IS DISTINCT FROM 0 OR(NEW.policy_snapshot#>>'{allocation,guest,amount}')::numeric IS DISTINCT FROM 0
     OR(NEW.policy_snapshot#>>'{allocation,alvillas,amount}')::numeric IS DISTINCT FROM NEW.amount
     OR jsonb_array_length(NEW.policy_snapshot->'policies') IS DISTINCT FROM 1 OR NEW.policy_snapshot#>>'{policies,0,organizationId}' IS DISTINCT FROM NEW.organization_id::text)
   THEN RAISE EXCEPTION 'company monthly costs cannot invent property or owner money';END IF;
  END IF;
  IF c.id IS NULL OR l.id IS NULL OR c.submission_id<>s.id OR l.run_id<>s.run_id OR l.person_id<>c.person_id
   OR l.amount<>NEW.amount OR l.currency<>NEW.currency OR l.completion_event_id IS DISTINCT FROM NEW.completion_event_id OR l.property_id IS DISTINCT FROM NEW.property_id
   OR expected IS NULL OR expected->>'personId' IS DISTINCT FROM c.person_id::text
   OR expected->>'completionEventId' IS DISTINCT FROM NEW.completion_event_id::text OR expected->>'propertyId' IS DISTINCT FROM NEW.property_id::text
   OR expected->>'reservationId' IS DISTINCT FROM NEW.reservation_id::text OR expected->>'category' IS DISTINCT FROM NEW.category
   OR expected->>'costCenter' IS DISTINCT FROM NEW.cost_center OR expected->>'note' IS DISTINCT FROM NEW.note OR expected->>'timezone' IS DISTINCT FROM NEW.timezone
   OR expected->>'costOn' IS DISTINCT FROM s.cost_on::text OR (expected#>>'{amount,amount}')::numeric IS DISTINCT FROM NEW.amount
   OR expected#>>'{amount,currency}' IS DISTINCT FROM NEW.currency OR expected->'policy' IS DISTINCT FROM NEW.policy_snapshot
   OR NEW.reservation_id IS DISTINCT FROM (CASE WHEN l.earning_kind='PER_MONTH' THEN(SELECT reservation_id FROM operation_task WHERE organization_id=NEW.organization_id AND id=l.task_id) ELSE(SELECT (after->>'reservation_id')::uuid FROM operation_task_event WHERE organization_id=NEW.organization_id AND id=NEW.completion_event_id) END)
  THEN RAISE EXCEPTION 'employee cost requires its exact immutable completed-work source and policy'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.organization_id::text||':employee-earned-source:'||CASE WHEN l.earning_kind='PER_MONTH' THEN 'monthly:'||l.assignment_id::text||':'||l.earning_period_key ELSE NEW.completion_event_id::text END,0));
  IF EXISTS(SELECT 1 FROM employee_compensation_cost old_cost JOIN employee_compensation_submission prior ON prior.organization_id=old_cost.organization_id AND prior.id=old_cost.submission_id
   LEFT JOIN approval_request a ON a.organization_id=prior.organization_id AND a.employee_submission_id=prior.id
   WHERE old_cost.organization_id=NEW.organization_id AND ((l.earning_kind IN('PER_JOB','PER_HOUR') AND old_cost.completion_event_id=NEW.completion_event_id) OR(l.earning_kind='PER_MONTH' AND EXISTS(SELECT 1 FROM employee_compensation_run_line prior_line WHERE prior_line.organization_id=old_cost.organization_id AND prior_line.id=old_cost.run_line_id AND prior_line.earning_kind='PER_MONTH' AND prior_line.assignment_id=l.assignment_id AND prior_line.earning_period_key=l.earning_period_key))) AND prior.id<>s.id
    AND NOT EXISTS(SELECT 1 FROM employee_compensation_withdrawal w WHERE w.organization_id=prior.organization_id AND w.submission_id=prior.id)
    AND NOT EXISTS(SELECT 1 FROM employee_compensation_correction corrected WHERE corrected.organization_id=old_cost.organization_id AND corrected.claim_id=old_cost.claim_id) AND COALESCE(a.state,'APPROVED')<>'REJECTED')
  THEN RAISE EXCEPTION 'completed work already belongs to an active employee claim'; END IF;
 END IF;
 NEW.created_at=clock_timestamp();RETURN NEW;
END $function$;
CREATE OR REPLACE FUNCTION public.app_assert_employee_percentage_cost(n employee_compensation_cost, s employee_compensation_submission, c employee_compensation_claim, l employee_compensation_run_line, expected jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE posting_ids jsonb;lock_key text;journal_uuid uuid;
BEGIN
 IF c.id IS NULL OR l.id IS NULL OR c.organization_id<>n.organization_id OR s.organization_id<>n.organization_id OR l.organization_id<>n.organization_id
  OR c.submission_id<>s.id OR l.run_id<>s.run_id OR c.person_id<>l.person_id OR l.earning_kind<>'PERCENTAGE'
  OR n.amount<>l.amount OR n.currency<>l.currency OR n.amount<=0 OR n.completion_event_id IS NOT NULL OR l.completion_event_id IS NOT NULL
  OR n.property_id IS DISTINCT FROM l.property_id OR expected IS NULL
 THEN RAISE EXCEPTION 'percentage cost requires its actual immutable earning and beneficiary';END IF;
 FOR lock_key IN SELECT DISTINCT 'percentage:'||line.person_id::text||':'||w.posting_id::text
   FROM employee_compensation_run_line line JOIN employee_compensation_percentage_witness w ON w.organization_id=line.organization_id AND w.run_line_id=line.id
   WHERE line.organization_id=n.organization_id AND line.run_id=s.run_id AND w.is_earning_base ORDER BY 1 LOOP
  PERFORM pg_advisory_xact_lock(hashtextextended(n.organization_id::text||':employee-earned-source:'||lock_key,0));
 END LOOP;
 FOR journal_uuid IN SELECT DISTINCT p.transaction_id FROM employee_compensation_percentage_witness w JOIN posting p ON p.organization_id=w.organization_id AND p.id=w.posting_id
  WHERE w.organization_id=n.organization_id AND w.run_line_id=l.id ORDER BY 1 LOOP
  PERFORM pg_advisory_xact_lock(hashtextextended(n.organization_id::text||':journal-reversal:'||journal_uuid::text,0));
 END LOOP;
 PERFORM app_assert_employee_percentage_line(l.organization_id,l.id);
 SELECT jsonb_agg(w.posting_id::text ORDER BY w.posting_id::text) INTO posting_ids FROM employee_compensation_percentage_witness w WHERE w.organization_id=n.organization_id AND w.run_line_id=l.id AND w.is_earning_base;
 IF expected->>'earningKind' IS DISTINCT FROM 'PERCENTAGE' OR expected->>'assignmentId' IS DISTINCT FROM l.assignment_id::text OR expected->'percentagePostingIds' IS DISTINCT FROM posting_ids
  OR n.policy_snapshot->>'schemaVersion' IS DISTINCT FROM '1' OR n.policy_snapshot->>'sourceKind' IS DISTINCT FROM 'employee_compensation_run_line'
  OR n.policy_snapshot->>'earningKind' IS DISTINCT FROM 'PERCENTAGE' OR n.policy_snapshot->>'assignmentId' IS DISTINCT FROM l.assignment_id::text OR n.policy_snapshot->'percentagePostingIds' IS DISTINCT FROM posting_ids
  OR n.policy_snapshot->>'runId' IS DISTINCT FROM l.run_id::text OR n.policy_snapshot->>'runLineId' IS DISTINCT FROM l.id::text OR n.policy_snapshot->>'personId' IS DISTINCT FROM l.person_id::text
  OR NOT(n.policy_snapshot ? 'completionEventId') OR n.policy_snapshot->>'completionEventId' IS NOT NULL
  OR expected->>'personId' IS DISTINCT FROM c.person_id::text OR expected->>'taskId' IS DISTINCT FROM l.task_id::text
  OR NOT(expected ? 'completionEventId') OR expected->>'completionEventId' IS NOT NULL OR NOT(expected ? 'propertyId') OR NOT(expected ? 'taskId')
  OR expected->>'propertyId' IS DISTINCT FROM n.property_id::text OR expected->>'reservationId' IS DISTINCT FROM n.reservation_id::text
  OR expected->>'category' IS DISTINCT FROM n.category OR expected->>'costCenter' IS DISTINCT FROM n.cost_center OR expected->>'note' IS DISTINCT FROM n.note OR expected->>'timezone' IS DISTINCT FROM n.timezone
  OR expected->>'costOn' IS DISTINCT FROM s.cost_on::text OR expected->>'recordedCompletionAt' IS DISTINCT FROM to_char(l.recorded_completion_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  OR (expected#>>'{amount,amount}')::numeric IS DISTINCT FROM n.amount OR expected#>>'{amount,currency}' IS DISTINCT FROM n.currency OR expected->'policy' IS DISTINCT FROM n.policy_snapshot
  OR n.policy_snapshot->>'propertyId' IS DISTINCT FROM n.property_id::text OR n.policy_snapshot->>'reservationId' IS DISTINCT FROM n.reservation_id::text
  OR n.policy_snapshot->>'recordedCompletionAt' IS DISTINCT FROM expected->>'recordedCompletionAt'
  OR n.policy_snapshot->>'occurredOn' IS DISTINCT FROM s.cost_on::text OR n.policy_snapshot->>'timezone' IS DISTINCT FROM n.timezone OR n.policy_snapshot->>'category' IS DISTINCT FROM n.category
  OR(n.policy_snapshot#>>'{amount,amount}')::numeric IS DISTINCT FROM n.amount OR n.policy_snapshot#>>'{amount,currency}' IS DISTINCT FROM n.currency
  OR n.reservation_id IS DISTINCT FROM(SELECT reservation_id FROM operation_task WHERE organization_id=n.organization_id AND id=l.task_id)
 THEN RAISE EXCEPTION 'percentage cost requires every exact original typed posting and retained approved policy';END IF;
 IF n.property_id IS NULL AND(n.reservation_id IS NOT NULL OR NOT(n.policy_snapshot ? 'propertyId') OR NOT(n.policy_snapshot ? 'reservationId')
  OR(n.policy_snapshot#>>'{allocation,owner,amount}')::numeric IS DISTINCT FROM 0 OR(n.policy_snapshot#>>'{allocation,guest,amount}')::numeric IS DISTINCT FROM 0
  OR(n.policy_snapshot#>>'{allocation,alvillas,amount}')::numeric IS DISTINCT FROM n.amount
  OR jsonb_array_length(n.policy_snapshot->'policies') IS DISTINCT FROM 1 OR n.policy_snapshot#>>'{policies,0,organizationId}' IS DISTINCT FROM n.organization_id::text)
 THEN RAISE EXCEPTION 'company percentage costs cannot invent property or owner money';END IF;
 IF EXISTS(SELECT 1 FROM employee_compensation_cost old_cost
  JOIN employee_compensation_submission prior ON prior.organization_id=old_cost.organization_id AND prior.id=old_cost.submission_id
  JOIN employee_compensation_run_line prior_line ON prior_line.organization_id=old_cost.organization_id AND prior_line.id=old_cost.run_line_id
  JOIN employee_compensation_percentage_witness prior_w ON prior_w.organization_id=prior_line.organization_id AND prior_w.run_line_id=prior_line.id AND prior_w.is_earning_base
  JOIN employee_compensation_percentage_witness current_w ON current_w.organization_id=prior_w.organization_id AND current_w.posting_id=prior_w.posting_id AND current_w.run_line_id=l.id AND current_w.is_earning_base
  LEFT JOIN approval_request a ON a.organization_id=prior.organization_id AND a.employee_submission_id=prior.id
  WHERE old_cost.organization_id=n.organization_id AND old_cost.id<>n.id AND prior_line.earning_kind='PERCENTAGE' AND prior_line.person_id=l.person_id
   AND NOT EXISTS(SELECT 1 FROM employee_compensation_withdrawal w WHERE w.organization_id=prior.organization_id AND w.submission_id=prior.id)
   AND NOT EXISTS(SELECT 1 FROM employee_compensation_correction corrected WHERE corrected.organization_id=old_cost.organization_id AND corrected.claim_id=old_cost.claim_id) AND COALESCE(a.state,'APPROVED')<>'REJECTED')
 THEN RAISE EXCEPTION 'original percentage posting already belongs to an active claim for this beneficiary';END IF;
END $function$;
COMMIT;
