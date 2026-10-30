BEGIN;
-- CreateTable
CREATE TABLE "employee_compensation_submission_request" (
    "id" UUID NOT NULL DEFAULT app_uuid_v7(),
    "organization_id" UUID NOT NULL,
    "run_id" UUID NOT NULL,
    "requested_by" UUID NOT NULL,
    "idempotency_key" UUID NOT NULL,
    "request_fingerprint" CHAR(64) NOT NULL,
    "input" JSONB NOT NULL,
    "authorization_cap" JSONB NOT NULL,
    "requested_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "employee_compensation_submission_request_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "employee_compensation_submission_outcome" (
    "id" UUID NOT NULL DEFAULT app_uuid_v7(),
    "organization_id" UUID NOT NULL,
    "request_id" UUID NOT NULL,
    "submission_id" UUID,
    "state" VARCHAR(16) NOT NULL,
    "failure_code" VARCHAR(80),
    "occurred_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "employee_compensation_submission_outcome_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "employee_submission_request_run_idx" ON "employee_compensation_submission_request"("organization_id", "run_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "employee_compensation_submission_request_organization_id_id_key" ON "employee_compensation_submission_request"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "employee_submission_request_nonce_unique" ON "employee_compensation_submission_request"("organization_id", "idempotency_key");

-- CreateIndex
CREATE UNIQUE INDEX "employee_compensation_submission_outcome_organization_id_id_key" ON "employee_compensation_submission_outcome"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "employee_submission_outcome_request_unique" ON "employee_compensation_submission_outcome"("organization_id", "request_id");

-- CreateIndex
CREATE UNIQUE INDEX "employee_submission_outcome_source_unique" ON "employee_compensation_submission_outcome"("organization_id", "submission_id");

-- AddForeignKey
ALTER TABLE "employee_compensation_submission_request" ADD CONSTRAINT "employee_compensation_submission_request_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "employee_compensation_submission_request" ADD CONSTRAINT "employee_submission_request_run_fk" FOREIGN KEY ("organization_id", "run_id") REFERENCES "employee_compensation_run"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "employee_compensation_submission_request" ADD CONSTRAINT "employee_submission_request_actor_fk" FOREIGN KEY ("organization_id", "requested_by") REFERENCES "user_account"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "employee_compensation_submission_outcome" ADD CONSTRAINT "employee_compensation_submission_outcome_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "employee_compensation_submission_outcome" ADD CONSTRAINT "employee_compensation_submission_outcome_organization_id_r_fkey" FOREIGN KEY ("organization_id", "request_id") REFERENCES "employee_compensation_submission_request"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "employee_compensation_submission_outcome" ADD CONSTRAINT "employee_compensation_submission_outcome_organization_id_s_fkey" FOREIGN KEY ("organization_id", "submission_id") REFERENCES "employee_compensation_submission"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;


ALTER TABLE employee_compensation_submission_request ADD CONSTRAINT employee_request_intent CHECK
 (request_fingerprint~'^[0-9a-f]{64}$' AND jsonb_typeof(input)='object' AND jsonb_typeof(authorization_cap)='object'
 AND input->>'runId'=run_id::text AND input->>'idempotencyKey'=idempotency_key::text
 AND length(btrim(input->>'reason')) BETWEEN 6 AND 500 AND jsonb_typeof(input->'costs')='array'
 AND authorization_cap->>'organizationId'=organization_id::text AND authorization_cap->>'userAccountId'=requested_by::text
 AND authorization_cap->>'schemaVersion'='1' AND (input-'runId'-'costOn'-'emergency'-'costs'-'idempotencyKey'-'reason')='{}'::jsonb);
ALTER TABLE employee_compensation_submission_outcome ADD CONSTRAINT employee_request_outcome_kind CHECK
 ((state='SUCCEEDED' AND submission_id IS NOT NULL AND failure_code IS NULL)
 OR (submission_id IS NULL AND ((state='DENIED' AND failure_code='ACCESS_DENIED') OR (state='CONFLICT' AND failure_code IN('SOURCE_CHANGED','POLICY_UNAVAILABLE')) OR (state='FAILED' AND failure_code='EXECUTION_UNAVAILABLE'))));

CREATE FUNCTION app_employee_submission_request_admission() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE source_count integer; requested_count integer;
BEGIN
 SELECT count(*) INTO source_count FROM employee_compensation_run_line WHERE organization_id=NEW.organization_id AND run_id=NEW.run_id AND amount>0;
 SELECT count(DISTINCT value->>'runLineId') INTO requested_count FROM jsonb_array_elements(NEW.input->'costs');
 IF source_count=0 OR requested_count<>source_count OR requested_count<>jsonb_array_length(NEW.input->'costs')
 OR EXISTS(SELECT 1 FROM jsonb_array_elements(NEW.input->'costs') item LEFT JOIN employee_compensation_run_line line
  ON line.organization_id=NEW.organization_id AND line.run_id=NEW.run_id AND line.id::text=item->>'runLineId' AND line.amount>0
  WHERE line.id IS NULL OR length(btrim(item->>'category')) NOT BETWEEN 1 AND 120 OR length(btrim(item->>'note')) NOT BETWEEN 6 AND 1000
   OR (item-'runLineId'-'category'-'costCenter'-'note')<>'{}'::jsonb)
 THEN RAISE EXCEPTION 'employee submission request requires every original positive source classification';END IF;
 NEW.requested_at=clock_timestamp();RETURN NEW;
END $$;
CREATE TRIGGER employee_submission_request_admission BEFORE INSERT ON employee_compensation_submission_request FOR EACH ROW EXECUTE FUNCTION app_employee_submission_request_admission();

CREATE FUNCTION app_employee_submission_request_complete() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE q employee_compensation_submission_request%ROWTYPE;
BEGIN
 SELECT * INTO q FROM employee_compensation_submission_request WHERE organization_id=NEW.organization_id AND id=NEW.id;
 IF (SELECT count(*) FROM audit_log x WHERE x.organization_id=q.organization_id AND x.resource_type='employee_compensation_run' AND x.resource_id=q.run_id
  AND x.action='finance.employee_compensation.submission_requested' AND x.actor_id=q.requested_by AND x.reason=q.input->>'reason' AND x.after->>'requestId'=q.id::text)<>1
  OR NOT EXISTS(SELECT 1 FROM outbox_event e WHERE e.organization_id=q.organization_id AND e.type='EmployeeCompensationSubmissionRequested'
   AND e.idempotency_key='employee-compensation-submission-request:'||q.id::text||':requested' AND e.payload=jsonb_build_object('requestId',q.id::text) AND e.occurred_at=date_trunc('milliseconds',q.requested_at))
 THEN RAISE EXCEPTION 'employee submission request requires its atomic attribution and private worker reference';END IF;RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER employee_submission_request_complete AFTER INSERT ON employee_compensation_submission_request DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app_employee_submission_request_complete();

CREATE FUNCTION app_employee_submission_outcome_complete() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE q employee_compensation_submission_request%ROWTYPE; s employee_compensation_submission%ROWTYPE;
BEGIN
 SELECT * INTO q FROM employee_compensation_submission_request WHERE organization_id=NEW.organization_id AND id=NEW.request_id;
 IF NEW.state='SUCCEEDED' THEN
  SELECT * INTO s FROM employee_compensation_submission WHERE organization_id=NEW.organization_id AND id=NEW.submission_id;
  IF s.id IS NULL OR s.run_id<>q.run_id OR s.submitted_by<>q.requested_by OR s.idempotency_key<>q.idempotency_key OR s.request_fingerprint<>q.request_fingerprint
   THEN RAISE EXCEPTION 'employee request success requires its actual exact submitted intent';END IF;
 END IF;
 IF NOT EXISTS(SELECT 1 FROM audit_log x WHERE x.organization_id=q.organization_id AND x.resource_type='employee_compensation_run' AND x.resource_id=q.run_id
  AND x.action='finance.employee_compensation.submission_completed' AND x.actor_id=q.requested_by AND x.reason=q.input->>'reason'
  AND x.after->>'requestId'=q.id::text AND x.after->>'outcomeId'=NEW.id::text AND x.after->>'state'=NEW.state
  AND x.after->>'submissionId' IS NOT DISTINCT FROM NEW.submission_id::text AND x.after->>'failureCode' IS NOT DISTINCT FROM NEW.failure_code)
 THEN RAISE EXCEPTION 'employee request outcome requires its actual attributed audit';END IF;RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER employee_submission_outcome_complete AFTER INSERT ON employee_compensation_submission_outcome DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app_employee_submission_outcome_complete();

CREATE FUNCTION app_employee_submission_outbox_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE q employee_compensation_submission_request%ROWTYPE;
BEGIN
 IF TG_OP<>'INSERT' AND OLD.type IN('EmployeeCompensationSubmissionRequested','EmployeeCompensationSubmitted','EmployeeCompensationWithdrawn') THEN
  IF TG_OP='DELETE' OR ROW(NEW.id,NEW.organization_id,NEW.type,NEW.payload,NEW.idempotency_key,NEW.occurred_at,NEW.created_at)
   IS DISTINCT FROM ROW(OLD.id,OLD.organization_id,OLD.type,OLD.payload,OLD.idempotency_key,OLD.occurred_at,OLD.created_at)
  THEN RAISE EXCEPTION 'employee worker and source references are immutable';END IF;
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD;END IF;
 IF NEW.type='EmployeeCompensationSubmissionRequested' THEN
  SELECT * INTO q FROM employee_compensation_submission_request WHERE organization_id=NEW.organization_id AND id::text=NEW.payload->>'requestId';
  IF q.id IS NULL OR NEW.payload<>jsonb_build_object('requestId',q.id::text) OR NEW.idempotency_key<>'employee-compensation-submission-request:'||q.id::text||':requested'
   OR NEW.occurred_at<>date_trunc('milliseconds',q.requested_at)
  THEN RAISE EXCEPTION 'employee worker reference requires its actual private request';END IF;
 END IF;RETURN NEW;
END $$;
CREATE TRIGGER employee_submission_outbox_guard BEFORE INSERT OR UPDATE OR DELETE ON outbox_event FOR EACH ROW EXECUTE FUNCTION app_employee_submission_outbox_guard();

ALTER TABLE employee_compensation_submission_request ENABLE ROW LEVEL SECURITY;
ALTER TABLE employee_compensation_submission_request FORCE ROW LEVEL SECURITY;
CREATE POLICY employee_compensation_submission_request_tenant ON employee_compensation_submission_request USING(organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid) WITH CHECK(organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid);
CREATE TRIGGER employee_request_immutable BEFORE UPDATE OR DELETE ON employee_compensation_submission_request FOR EACH ROW EXECUTE FUNCTION app_prevent_ledger_mutation();

ALTER TABLE employee_compensation_submission_outcome ENABLE ROW LEVEL SECURITY;
ALTER TABLE employee_compensation_submission_outcome FORCE ROW LEVEL SECURITY;
CREATE POLICY employee_compensation_submission_outcome_tenant ON employee_compensation_submission_outcome USING(organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid) WITH CHECK(organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid);
CREATE TRIGGER employee_request_immutable BEFORE UPDATE OR DELETE ON employee_compensation_submission_outcome FOR EACH ROW EXECUTE FUNCTION app_prevent_ledger_mutation();

COMMIT;
