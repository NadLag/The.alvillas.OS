BEGIN;
-- CreateTable
CREATE TABLE "employee_monthly_run_request" (
    "id" UUID NOT NULL DEFAULT app_uuid_v7(),
    "organization_id" UUID NOT NULL,
    "requested_by" UUID NOT NULL,
    "idempotency_key" UUID NOT NULL,
    "request_fingerprint" CHAR(64) NOT NULL,
    "reviewed_source_fingerprint" CHAR(64) NOT NULL,
    "policy_rule_id" UUID NOT NULL,
    "input" JSONB NOT NULL,
    "review" JSONB NOT NULL,
    "authorization_cap" JSONB NOT NULL,
    "requested_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "employee_monthly_run_request_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "employee_monthly_run_outcome" (
    "id" UUID NOT NULL DEFAULT app_uuid_v7(),
    "organization_id" UUID NOT NULL,
    "request_id" UUID NOT NULL,
    "run_id" UUID,
    "state" VARCHAR(16) NOT NULL,
    "failure_code" VARCHAR(80),
    "occurred_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "employee_monthly_run_outcome_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "employee_monthly_request_actor_idx" ON "employee_monthly_run_request"("organization_id", "requested_by", "id");

-- CreateIndex
CREATE UNIQUE INDEX "employee_monthly_run_request_organization_id_id_key" ON "employee_monthly_run_request"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "employee_monthly_request_nonce_unique" ON "employee_monthly_run_request"("organization_id", "idempotency_key");

-- CreateIndex
CREATE UNIQUE INDEX "employee_monthly_run_outcome_organization_id_id_key" ON "employee_monthly_run_outcome"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "employee_monthly_outcome_request_unique" ON "employee_monthly_run_outcome"("organization_id", "request_id");

-- CreateIndex
CREATE UNIQUE INDEX "employee_monthly_outcome_source_unique" ON "employee_monthly_run_outcome"("organization_id", "run_id");

-- AddForeignKey
ALTER TABLE "employee_monthly_run_request" ADD CONSTRAINT "employee_monthly_run_request_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "employee_monthly_run_request" ADD CONSTRAINT "employee_monthly_request_actor_fk" FOREIGN KEY ("organization_id", "requested_by") REFERENCES "user_account"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "employee_monthly_run_request" ADD CONSTRAINT "employee_monthly_request_policy_fk" FOREIGN KEY ("organization_id", "policy_rule_id") REFERENCES "config_rule"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "employee_monthly_run_outcome" ADD CONSTRAINT "employee_monthly_run_outcome_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "employee_monthly_run_outcome" ADD CONSTRAINT "employee_monthly_run_outcome_organization_id_request_id_fkey" FOREIGN KEY ("organization_id", "request_id") REFERENCES "employee_monthly_run_request"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "employee_monthly_run_outcome" ADD CONSTRAINT "employee_monthly_run_outcome_organization_id_run_id_fkey" FOREIGN KEY ("organization_id", "run_id") REFERENCES "employee_compensation_run"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;


ALTER TABLE employee_monthly_run_request ADD CONSTRAINT employee_monthly_request_intent CHECK ((
 request_fingerprint~'^[a-f0-9]{64}$' AND reviewed_source_fingerprint~'^[a-f0-9]{64}$'
 AND jsonb_typeof(input)='object' AND jsonb_typeof(review)='object' AND jsonb_typeof(authorization_cap)='object'
 AND input->>'idempotencyKey'=idempotency_key::text AND input->>'month'~'^[0-9]{4}-(0[1-9]|1[0-2])$'
 AND input->>'currency'~'^[A-Z]{3}$' AND length(btrim(input->>'purpose')) BETWEEN 3 AND 1000
 AND length(btrim(input->>'reason')) BETWEEN 6 AND 500 AND jsonb_typeof(input->'assignments')='array'
 AND jsonb_array_length(input->'assignments') BETWEEN 1 AND 10000
 AND (input-'month'-'currency'-'assignments'-'purpose'-'reason'-'idempotencyKey')='{}'::jsonb
 AND authorization_cap->>'organizationId'=organization_id::text AND authorization_cap->>'userAccountId'=requested_by::text
 AND authorization_cap->>'schemaVersion'='1' AND review#>>'{amount,currency}'=input->>'currency'
 AND review#>>'{amount,amount}'~'^(0|[1-9][0-9]*)\.[0-9]{2}$' AND jsonb_typeof(review->'beneficiaries')='array'
 AND jsonb_array_length(review->'beneficiaries') BETWEEN 1 AND 10000 AND (review-'amount'-'beneficiaries')='{}'::jsonb
) IS TRUE);
ALTER TABLE employee_monthly_run_outcome ADD CONSTRAINT employee_monthly_outcome_kind CHECK ((
 (state='SUCCEEDED' AND run_id IS NOT NULL AND failure_code IS NULL)
 OR (run_id IS NULL AND ((state='DENIED' AND failure_code='ACCESS_DENIED') OR (state='CONFLICT' AND failure_code IN('SOURCE_CHANGED','POLICY_UNAVAILABLE')) OR (state='FAILED' AND failure_code='EXECUTION_UNAVAILABLE')))
) IS TRUE);

CREATE FUNCTION app_employee_monthly_request_admission() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE p config_rule%ROWTYPE; count_people integer; amount_sum numeric;
BEGIN
 SELECT * INTO p FROM config_rule WHERE organization_id=NEW.organization_id AND id=NEW.policy_rule_id;
 IF p.id IS NULL OR p.key<>'staff.compensation_monthly_earnings' OR p.scope_type<>'organization' OR p.scope_id IS NOT NULL
 OR date_trunc('month',(NEW.input->>'month'||'-01')::date)+interval '1 month'>(clock_timestamp() AT TIME ZONE (p.value->>'timezone'))
 OR (SELECT count(DISTINCT item->>'assignmentId') FROM jsonb_array_elements(NEW.input->'assignments') item)<>jsonb_array_length(NEW.input->'assignments')
 OR EXISTS(SELECT 1 FROM jsonb_array_elements(NEW.input->'assignments') item LEFT JOIN role_assignment a
   ON a.organization_id=NEW.organization_id AND a.id::text=item->>'assignmentId'
   WHERE a.id IS NULL OR item->'confirmedAssignment' IS DISTINCT FROM 'true'::jsonb OR (item-'assignmentId'-'confirmedAssignment')<>'{}'::jsonb)
 OR EXISTS(SELECT 1 FROM jsonb_array_elements(NEW.review->'beneficiaries') item
   WHERE (item-'personId'-'amount')<>'{}'::jsonb OR item#>>'{amount,currency}' IS DISTINCT FROM NEW.input->>'currency'
    OR (item#>>'{amount,amount}'~'^(0|[1-9][0-9]*)\.[0-9]{2}$') IS NOT TRUE
    OR NOT EXISTS(SELECT 1 FROM role_assignment a JOIN jsonb_array_elements(NEW.input->'assignments') selected ON selected->>'assignmentId'=a.id::text
      WHERE a.organization_id=NEW.organization_id AND a.person_id::text=item->>'personId'))
 THEN RAISE EXCEPTION 'monthly request requires actual unique tenant contract selections and attributed reviewed intent';END IF;
 SELECT count(DISTINCT a.person_id) INTO count_people FROM role_assignment a JOIN jsonb_array_elements(NEW.input->'assignments') selected ON selected->>'assignmentId'=a.id::text WHERE a.organization_id=NEW.organization_id;
 SELECT sum((item#>>'{amount,amount}')::numeric) INTO amount_sum FROM jsonb_array_elements(NEW.review->'beneficiaries') item;
 IF count_people<>jsonb_array_length(NEW.review->'beneficiaries') OR count_people<>(SELECT count(DISTINCT item->>'personId') FROM jsonb_array_elements(NEW.review->'beneficiaries') item)
 OR amount_sum IS DISTINCT FROM (NEW.review#>>'{amount,amount}')::numeric THEN RAISE EXCEPTION 'monthly request must retain complete beneficiary and selected total authority';END IF;
 NEW.requested_at=date_trunc('milliseconds',clock_timestamp());RETURN NEW;
END $$;
CREATE TRIGGER employee_monthly_request_admission BEFORE INSERT ON employee_monthly_run_request FOR EACH ROW EXECUTE FUNCTION app_employee_monthly_request_admission();

CREATE FUNCTION app_employee_monthly_request_complete() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE q employee_monthly_run_request%ROWTYPE; born xid;
BEGIN
 SELECT * INTO q FROM employee_monthly_run_request WHERE organization_id=NEW.organization_id AND id=NEW.id;
 SELECT xmin INTO born FROM employee_monthly_run_request WHERE organization_id=NEW.organization_id AND id=NEW.id;
 IF (SELECT count(*) FROM audit_log x WHERE x.organization_id=q.organization_id AND x.resource_type='employee_monthly_run_request' AND x.resource_id=q.id
  AND x.action='finance.employee_compensation.monthly_run_requested' AND x.actor_id=q.requested_by AND x.reason=q.input->>'reason' AND x.after=jsonb_build_object('requestId',q.id::text) AND x.xmin=born)<>1
 OR NOT EXISTS(SELECT 1 FROM outbox_event e WHERE e.organization_id=q.organization_id AND e.type='EmployeeMonthlyRunRequested'
  AND e.idempotency_key='employee-monthly-run-request:'||q.id::text||':requested' AND e.payload=jsonb_build_object('requestId',q.id::text) AND e.occurred_at=q.requested_at AND e.xmin=born)
 THEN RAISE EXCEPTION 'monthly request requires atomic attributed audit and private worker reference';END IF;RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER employee_monthly_request_complete AFTER INSERT ON employee_monthly_run_request DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app_employee_monthly_request_complete();

CREATE FUNCTION app_employee_monthly_outcome_complete() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE q employee_monthly_run_request%ROWTYPE; r employee_compensation_run%ROWTYPE; born xid; run_born xid;
BEGIN
 SELECT * INTO q FROM employee_monthly_run_request WHERE organization_id=NEW.organization_id AND id=NEW.request_id;
 SELECT xmin INTO born FROM employee_monthly_run_outcome WHERE organization_id=NEW.organization_id AND id=NEW.id;
 IF NEW.state='SUCCEEDED' THEN
  SELECT * INTO r FROM employee_compensation_run WHERE organization_id=NEW.organization_id AND id=NEW.run_id;
  SELECT xmin INTO run_born FROM employee_compensation_run WHERE organization_id=NEW.organization_id AND id=NEW.run_id;
  IF r.id IS NULL OR run_born IS DISTINCT FROM born OR r.created_at<q.requested_at OR r.earning_kind<>'PER_MONTH' OR r.created_by<>q.requested_by
   OR r.idempotency_key<>q.idempotency_key OR r.request_fingerprint<>q.request_fingerprint OR r.policy_rule_id<>q.policy_rule_id
   OR r.purpose IS DISTINCT FROM q.input->>'purpose' OR r.reason IS DISTINCT FROM q.input->>'reason' OR r.currency IS DISTINCT FROM q.input->>'currency'
   OR r.from_on IS DISTINCT FROM (q.input->>'month'||'-01')::date
   OR (SELECT sum(amount) FROM employee_compensation_run_line WHERE organization_id=q.organization_id AND run_id=r.id) IS DISTINCT FROM (q.review#>>'{amount,amount}')::numeric
   OR (SELECT count(*) FROM employee_compensation_run_line WHERE organization_id=q.organization_id AND run_id=r.id)<>jsonb_array_length(q.input->'assignments')
   OR EXISTS(SELECT 1 FROM employee_compensation_run_line l WHERE l.organization_id=q.organization_id AND l.run_id=r.id AND
     (l.earning_period_key IS DISTINCT FROM q.input->>'month' OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(q.input->'assignments') item WHERE item->>'assignmentId'=l.assignment_id::text)))
   OR EXISTS(SELECT 1 FROM jsonb_array_elements(q.review->'beneficiaries') item WHERE (item#>>'{amount,amount}')::numeric IS DISTINCT FROM
     (SELECT sum(l.amount) FROM employee_compensation_run_line l WHERE l.organization_id=q.organization_id AND l.run_id=r.id AND l.person_id::text=item->>'personId'))
  THEN RAISE EXCEPTION 'monthly success requires its newly created complete exact contractual run';END IF;
 END IF;
 IF NOT EXISTS(SELECT 1 FROM audit_log x WHERE x.organization_id=q.organization_id AND x.resource_type='employee_monthly_run_request' AND x.resource_id=q.id
  AND x.action='finance.employee_compensation.monthly_run_completed' AND x.actor_id=q.requested_by AND x.reason=q.input->>'reason' AND x.xmin=born
  AND x.after=jsonb_build_object('requestId',q.id::text,'outcomeId',NEW.id::text,'state',NEW.state,'runId',NEW.run_id::text,'failureCode',NEW.failure_code))
 THEN RAISE EXCEPTION 'monthly outcome requires its atomic attributed audit';END IF;RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER employee_monthly_outcome_complete AFTER INSERT ON employee_monthly_run_outcome DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app_employee_monthly_outcome_complete();

CREATE FUNCTION app_employee_monthly_outbox_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE q employee_monthly_run_request%ROWTYPE;
BEGIN
 IF TG_OP<>'INSERT' AND OLD.type='EmployeeMonthlyRunRequested' THEN
  IF TG_OP='DELETE' OR ROW(NEW.id,NEW.organization_id,NEW.type,NEW.payload,NEW.idempotency_key,NEW.occurred_at,NEW.created_at) IS DISTINCT FROM ROW(OLD.id,OLD.organization_id,OLD.type,OLD.payload,OLD.idempotency_key,OLD.occurred_at,OLD.created_at)
  THEN RAISE EXCEPTION 'monthly worker reference is immutable';END IF;
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD;END IF;
 IF NEW.type='EmployeeMonthlyRunRequested' THEN
  SELECT * INTO q FROM employee_monthly_run_request WHERE organization_id=NEW.organization_id AND id::text=NEW.payload->>'requestId';
  IF q.id IS NULL OR NEW.payload<>jsonb_build_object('requestId',q.id::text) OR NEW.idempotency_key<>'employee-monthly-run-request:'||q.id::text||':requested' OR NEW.occurred_at<>q.requested_at
  THEN RAISE EXCEPTION 'monthly worker reference requires its actual private intent';END IF;
 END IF;RETURN NEW;
END $$;
CREATE TRIGGER employee_monthly_outbox_guard BEFORE INSERT OR UPDATE OR DELETE ON outbox_event FOR EACH ROW EXECUTE FUNCTION app_employee_monthly_outbox_guard();

ALTER TABLE employee_monthly_run_request ENABLE ROW LEVEL SECURITY;
ALTER TABLE employee_monthly_run_request FORCE ROW LEVEL SECURITY;
CREATE POLICY employee_monthly_run_request_tenant ON employee_monthly_run_request USING(organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid) WITH CHECK(organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid);
CREATE TRIGGER employee_monthly_request_immutable BEFORE UPDATE OR DELETE ON employee_monthly_run_request FOR EACH ROW EXECUTE FUNCTION app_prevent_ledger_mutation();
ALTER TABLE employee_monthly_run_outcome ENABLE ROW LEVEL SECURITY;
ALTER TABLE employee_monthly_run_outcome FORCE ROW LEVEL SECURITY;
CREATE POLICY employee_monthly_run_outcome_tenant ON employee_monthly_run_outcome USING(organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid) WITH CHECK(organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid);
CREATE TRIGGER employee_monthly_outcome_immutable BEFORE UPDATE OR DELETE ON employee_monthly_run_outcome FOR EACH ROW EXECUTE FUNCTION app_prevent_ledger_mutation();

COMMIT;
