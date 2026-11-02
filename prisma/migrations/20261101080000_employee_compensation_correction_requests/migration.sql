BEGIN;
-- AlterTable
ALTER TABLE "employee_compensation_recognition_outcome" ADD COLUMN     "correction_id" UUID;

-- AlterTable
ALTER TABLE "employee_compensation_recognition_request" ADD COLUMN     "operation" VARCHAR(16) NOT NULL DEFAULT 'RECOGNIZE',
ADD COLUMN     "original_recognition_id" UUID;

-- CreateIndex
CREATE INDEX "employee_correction_outcome_idx" ON "employee_compensation_recognition_outcome"("organization_id", "correction_id");

-- CreateIndex
CREATE INDEX "employee_recognition_request_actor_operation_idx" ON "employee_compensation_recognition_request"("organization_id", "claim_id", "operation", "requested_by", "requested_at", "id");

-- AddForeignKey
ALTER TABLE "employee_compensation_recognition_request" ADD CONSTRAINT "employee_correction_request_source_fk" FOREIGN KEY ("organization_id", "original_recognition_id") REFERENCES "employee_compensation_recognition"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "employee_compensation_recognition_outcome" ADD CONSTRAINT "employee_correction_outcome_source_fk" FOREIGN KEY ("organization_id", "correction_id") REFERENCES "employee_compensation_correction"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;


ALTER TABLE employee_compensation_recognition_request DROP CONSTRAINT employee_recognition_request_intent;
ALTER TABLE employee_compensation_recognition_request ADD CONSTRAINT employee_recognition_request_intent CHECK((
 request_fingerprint~'^[0-9a-f]{64}$' AND jsonb_typeof(input)='object' AND jsonb_typeof(authorization_cap)='object'
 AND input->>'id'=submission_id::text AND input->>'claimId'=claim_id::text AND input->>'idempotencyKey'=idempotency_key::text
 AND length(btrim(input->>'reason')) BETWEEN 6 AND 500
 AND authorization_cap->>'organizationId'=organization_id::text AND authorization_cap->>'userAccountId'=requested_by::text
 AND authorization_cap->>'schemaVersion'='1'
 AND ((operation='RECOGNIZE' AND original_recognition_id IS NULL AND jsonb_typeof(input->'currentPeriod')='boolean'
   AND (input-'id'-'claimId'-'currentPeriod'-'idempotencyKey'-'reason')='{}'::jsonb)
  OR(operation='REVERSE' AND original_recognition_id IS NOT NULL AND input->>'recognitionId'=original_recognition_id::text
   AND (input-'id'-'claimId'-'recognitionId'-'idempotencyKey'-'reason')='{}'::jsonb))) IS TRUE);
ALTER TABLE employee_compensation_recognition_outcome DROP CONSTRAINT employee_recognition_outcome_kind;
ALTER TABLE employee_compensation_recognition_outcome ADD CONSTRAINT employee_recognition_outcome_kind CHECK((
 (state='SUCCEEDED' AND num_nonnulls(recognition_id,correction_id)=1 AND failure_code IS NULL)
 OR (recognition_id IS NULL AND correction_id IS NULL AND ((state='DENIED' AND failure_code='ACCESS_DENIED')
  OR(state='CONFLICT' AND failure_code IN('SOURCE_CHANGED','POLICY_UNAVAILABLE','PERIOD_CLOSED'))
  OR(state='FAILED' AND failure_code='EXECUTION_UNAVAILABLE')))) IS TRUE);

CREATE OR REPLACE FUNCTION app_employee_recognition_request_admission() RETURNS trigger LANGUAGE plpgsql SET search_path TO 'public','pg_temp' AS $$
DECLARE r employee_compensation_recognition%ROWTYPE; birth text;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM employee_compensation_claim WHERE organization_id=NEW.organization_id AND id=NEW.claim_id AND submission_id=NEW.submission_id)
 THEN RAISE EXCEPTION 'employee recognition request requires its actual submitted beneficiary';END IF;
 IF NEW.operation='REVERSE' THEN
  SELECT * INTO r FROM employee_compensation_recognition WHERE organization_id=NEW.organization_id AND id=NEW.original_recognition_id;
  SELECT xmin::text INTO birth FROM employee_compensation_recognition WHERE organization_id=NEW.organization_id AND id=NEW.original_recognition_id;
  IF r.id IS NULL OR r.claim_id<>NEW.claim_id OR r.submission_id<>NEW.submission_id
   OR birth::bigint=mod(pg_current_xact_id()::text::numeric,4294967296)::bigint
  THEN RAISE EXCEPTION 'employee correction admission requires its actual committed original recognition';END IF;
 END IF;
 NEW.requested_at=clock_timestamp();RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION app_employee_recognition_request_complete() RETURNS trigger LANGUAGE plpgsql SET search_path TO 'public','pg_temp' AS $$
DECLARE action_name text;
BEGIN
 action_name=CASE WHEN NEW.operation='RECOGNIZE' THEN 'finance.employee_compensation.recognition_requested' ELSE 'finance.employee_compensation.correction_requested' END;
 IF (SELECT count(*) FROM audit_log x WHERE x.organization_id=NEW.organization_id AND x.resource_type='employee_compensation_claim' AND x.resource_id=NEW.claim_id
   AND x.action=action_name AND x.actor_id=NEW.requested_by AND x.reason=NEW.input->>'reason' AND x.after->>'requestId'=NEW.id::text
   AND x.xmin::text::bigint=mod(pg_current_xact_id()::text::numeric,4294967296)::bigint)<>1
  OR NOT EXISTS(SELECT 1 FROM outbox_event e WHERE e.organization_id=NEW.organization_id AND e.type='EmployeeCompensationRecognitionRequested'
   AND e.idempotency_key='employee-compensation-recognition-request:'||NEW.id::text||':requested' AND e.payload=jsonb_build_object('requestId',NEW.id::text) AND e.occurred_at=date_trunc('milliseconds',NEW.requested_at)
   AND e.xmin::text::bigint=mod(pg_current_xact_id()::text::numeric,4294967296)::bigint)
  OR NOT EXISTS(SELECT 1 FROM outbox_event dispatch WHERE dispatch.organization_id=NEW.organization_id AND dispatch.type='alvillas/outbox.dispatch.requested'
   AND dispatch.idempotency_key='employee-recognition:'||NEW.id::text||':dispatch' AND dispatch.payload='{}'::jsonb
   AND dispatch.xmin::text::bigint=mod(pg_current_xact_id()::text::numeric,4294967296)::bigint)
 THEN RAISE EXCEPTION 'employee financial request requires its atomic attribution, private worker reference and durable dispatch';END IF;RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION app_employee_recognition_outcome_complete() RETURNS trigger LANGUAGE plpgsql SET search_path TO 'public','pg_temp' AS $$
DECLARE q employee_compensation_recognition_request%ROWTYPE; r employee_compensation_recognition%ROWTYPE; c employee_compensation_correction%ROWTYPE; action_name text;
BEGIN
 SELECT * INTO q FROM employee_compensation_recognition_request WHERE organization_id=NEW.organization_id AND id=NEW.request_id;
 IF q.id IS NULL THEN RAISE EXCEPTION 'employee financial outcome requires its original private request';END IF;
 IF NEW.state='SUCCEEDED' THEN
  IF q.operation='RECOGNIZE' THEN
   SELECT * INTO r FROM employee_compensation_recognition WHERE organization_id=NEW.organization_id AND id=NEW.recognition_id;
   IF NEW.correction_id IS NOT NULL OR r.id IS NULL OR r.submission_id<>q.submission_id OR r.claim_id<>q.claim_id OR r.created_by<>q.requested_by OR r.idempotency_key<>q.idempotency_key OR r.request_fingerprint<>q.request_fingerprint
   THEN RAISE EXCEPTION 'employee recognition success requires its actual exact intent';END IF;
  ELSE
   SELECT * INTO c FROM employee_compensation_correction WHERE organization_id=NEW.organization_id AND id=NEW.correction_id;
   IF NEW.recognition_id IS NOT NULL OR c.id IS NULL OR c.submission_id<>q.submission_id OR c.claim_id<>q.claim_id OR c.recognition_id IS DISTINCT FROM q.original_recognition_id
    OR c.created_by<>q.requested_by OR c.idempotency_key<>q.idempotency_key OR c.request_fingerprint<>q.request_fingerprint OR c.reason IS DISTINCT FROM q.input->>'reason'
   THEN RAISE EXCEPTION 'employee correction success requires its actual exact original intent and typed opposite history';END IF;
  END IF;
 END IF;
 action_name=CASE WHEN q.operation='RECOGNIZE' THEN 'finance.employee_compensation.recognition_completed' ELSE 'finance.employee_compensation.correction_completed' END;
 IF NOT EXISTS(SELECT 1 FROM audit_log x WHERE x.organization_id=q.organization_id AND x.resource_type='employee_compensation_claim' AND x.resource_id=q.claim_id
  AND x.action=action_name AND x.actor_id=q.requested_by AND x.reason=q.input->>'reason'
  AND x.after->>'requestId'=q.id::text AND x.after->>'outcomeId'=NEW.id::text AND x.after->>'state'=NEW.state
  AND x.after->>'recognitionId' IS NOT DISTINCT FROM NEW.recognition_id::text AND x.after->>'failureCode' IS NOT DISTINCT FROM NEW.failure_code
  AND (q.operation='RECOGNIZE' OR(x.after->>'correctionId' IS NOT DISTINCT FROM NEW.correction_id::text AND x.after->>'originalRecognitionId'=q.original_recognition_id::text))
  AND x.xmin::text::bigint=mod(pg_current_xact_id()::text::numeric,4294967296)::bigint)
 THEN RAISE EXCEPTION 'employee financial outcome requires its actual attributed atomic audit';END IF;RETURN NEW;
END $$;

COMMIT;
