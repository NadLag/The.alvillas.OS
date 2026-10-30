BEGIN;

-- CreateTable
CREATE TABLE "employee_compensation_run" (
    "id" UUID NOT NULL DEFAULT app_uuid_v7(),
    "organization_id" UUID NOT NULL,
    "created_by" UUID NOT NULL,
    "idempotency_key" UUID NOT NULL,
    "request_fingerprint" CHAR(64) NOT NULL,
    "from_on" DATE NOT NULL,
    "to_on" DATE NOT NULL,
    "timezone" VARCHAR(120) NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "purpose" VARCHAR(1000) NOT NULL,
    "reason" VARCHAR(500) NOT NULL,
    "policy_rule_id" UUID NOT NULL,
    "policy_snapshot" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "employee_compensation_run_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "employee_compensation_run_line" (
    "id" UUID NOT NULL DEFAULT app_uuid_v7(),
    "organization_id" UUID NOT NULL,
    "run_id" UUID NOT NULL,
    "person_id" UUID NOT NULL,
    "assignment_id" UUID NOT NULL,
    "compensation_id" UUID NOT NULL,
    "config_rule_id" UUID NOT NULL,
    "task_id" UUID NOT NULL,
    "completion_event_id" UUID NOT NULL,
    "property_id" UUID NOT NULL,
    "recorded_completion_at" TIMESTAMPTZ(6) NOT NULL,
    "rate" DECIMAL(18,2) NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "source_snapshot" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "employee_compensation_run_line_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "employee_compensation_run_cancellation" (
    "id" UUID NOT NULL DEFAULT app_uuid_v7(),
    "organization_id" UUID NOT NULL,
    "run_id" UUID NOT NULL,
    "cancelled_by" UUID NOT NULL,
    "reason" VARCHAR(500) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "employee_compensation_run_cancellation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "employee_compensation_run_organization_id_created_at_id_idx" ON "employee_compensation_run"("organization_id", "created_at", "id");

-- CreateIndex
CREATE UNIQUE INDEX "employee_compensation_run_organization_id_id_key" ON "employee_compensation_run"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "employee_compensation_run_organization_id_idempotency_key_key" ON "employee_compensation_run"("organization_id", "idempotency_key");

-- CreateIndex
CREATE INDEX "employee_compensation_run_line_organization_id_person_id_re_idx" ON "employee_compensation_run_line"("organization_id", "person_id", "recorded_completion_at", "id");

-- CreateIndex
CREATE INDEX "employee_compensation_run_line_organization_id_task_id_idx" ON "employee_compensation_run_line"("organization_id", "task_id");

-- CreateIndex
CREATE UNIQUE INDEX "employee_compensation_run_line_organization_id_id_key" ON "employee_compensation_run_line"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "employee_compensation_run_line_organization_id_run_id_task__key" ON "employee_compensation_run_line"("organization_id", "run_id", "task_id");

-- CreateIndex
CREATE UNIQUE INDEX "employee_compensation_run_cancellation_organization_id_id_key" ON "employee_compensation_run_cancellation"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "employee_compensation_run_cancellation_organization_id_run__key" ON "employee_compensation_run_cancellation"("organization_id", "run_id");

-- CreateIndex
CREATE UNIQUE INDEX "operation_task_event_org_id_unique" ON "operation_task_event"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "team_compensation_org_id_unique" ON "team_compensation"("organization_id", "id");

-- AddForeignKey
ALTER TABLE "employee_compensation_run" ADD CONSTRAINT "employee_compensation_run_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "employee_compensation_run" ADD CONSTRAINT "employee_compensation_run_organization_id_created_by_fkey" FOREIGN KEY ("organization_id", "created_by") REFERENCES "user_account"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "employee_compensation_run" ADD CONSTRAINT "employee_compensation_run_organization_id_policy_rule_id_fkey" FOREIGN KEY ("organization_id", "policy_rule_id") REFERENCES "config_rule"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "employee_compensation_run" ADD CONSTRAINT "employee_compensation_run_currency_fkey" FOREIGN KEY ("currency") REFERENCES "currency"("code") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "employee_compensation_run_line" ADD CONSTRAINT "employee_compensation_run_line_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "employee_compensation_run_line" ADD CONSTRAINT "employee_compensation_run_line_organization_id_run_id_fkey" FOREIGN KEY ("organization_id", "run_id") REFERENCES "employee_compensation_run"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "employee_compensation_run_line" ADD CONSTRAINT "employee_compensation_run_line_organization_id_person_id_fkey" FOREIGN KEY ("organization_id", "person_id") REFERENCES "person"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "employee_compensation_run_line" ADD CONSTRAINT "employee_compensation_run_line_organization_id_assignment__fkey" FOREIGN KEY ("organization_id", "assignment_id") REFERENCES "role_assignment"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "employee_compensation_run_line" ADD CONSTRAINT "employee_compensation_run_line_organization_id_compensatio_fkey" FOREIGN KEY ("organization_id", "compensation_id") REFERENCES "team_compensation"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "employee_compensation_run_line" ADD CONSTRAINT "employee_compensation_run_line_organization_id_config_rule_fkey" FOREIGN KEY ("organization_id", "config_rule_id") REFERENCES "config_rule"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "employee_compensation_run_line" ADD CONSTRAINT "employee_compensation_run_line_organization_id_task_id_fkey" FOREIGN KEY ("organization_id", "task_id") REFERENCES "operation_task"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "employee_compensation_run_line" ADD CONSTRAINT "employee_compensation_run_line_organization_id_completion__fkey" FOREIGN KEY ("organization_id", "completion_event_id") REFERENCES "operation_task_event"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "employee_compensation_run_line" ADD CONSTRAINT "employee_compensation_run_line_organization_id_property_id_fkey" FOREIGN KEY ("organization_id", "property_id") REFERENCES "property"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "employee_compensation_run_line" ADD CONSTRAINT "employee_compensation_run_line_currency_fkey" FOREIGN KEY ("currency") REFERENCES "currency"("code") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "employee_compensation_run_cancellation" ADD CONSTRAINT "employee_compensation_run_cancellation_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "employee_compensation_run_cancellation" ADD CONSTRAINT "employee_compensation_run_cancellation_organization_id_run_fkey" FOREIGN KEY ("organization_id", "run_id") REFERENCES "employee_compensation_run"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "employee_compensation_run_cancellation" ADD CONSTRAINT "employee_compensation_run_cancellation_organization_id_can_fkey" FOREIGN KEY ("organization_id", "cancelled_by") REFERENCES "user_account"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;


ALTER TABLE employee_compensation_run ADD CONSTRAINT employee_compensation_run_fields CHECK
 (from_on<=to_on AND request_fingerprint ~ '^[0-9a-f]{64}$' AND length(btrim(purpose)) BETWEEN 3 AND 1000 AND length(btrim(reason)) BETWEEN 6 AND 500);
ALTER TABLE employee_compensation_run_line ADD CONSTRAINT employee_compensation_run_line_fields CHECK(rate>=0 AND amount=rate);
ALTER TABLE employee_compensation_run_cancellation ADD CONSTRAINT employee_compensation_run_cancellation_fields CHECK(length(btrim(reason)) BETWEEN 6 AND 500);

ALTER TABLE employee_compensation_run ENABLE ROW LEVEL SECURITY;
ALTER TABLE employee_compensation_run FORCE ROW LEVEL SECURITY;
CREATE POLICY employee_compensation_run_tenant_isolation ON employee_compensation_run
 USING(organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid)
 WITH CHECK(organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid);
ALTER TABLE employee_compensation_run_line ENABLE ROW LEVEL SECURITY;
ALTER TABLE employee_compensation_run_line FORCE ROW LEVEL SECURITY;
CREATE POLICY employee_compensation_run_line_tenant_isolation ON employee_compensation_run_line
 USING(organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid)
 WITH CHECK(organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid);
ALTER TABLE employee_compensation_run_cancellation ENABLE ROW LEVEL SECURITY;
ALTER TABLE employee_compensation_run_cancellation FORCE ROW LEVEL SECURITY;
CREATE POLICY employee_compensation_run_cancellation_tenant_isolation ON employee_compensation_run_cancellation
 USING(organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid)
 WITH CHECK(organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid);
CREATE TRIGGER employee_compensation_run_immutable BEFORE UPDATE OR DELETE ON employee_compensation_run
 FOR EACH ROW EXECUTE FUNCTION app_prevent_ledger_mutation();
CREATE TRIGGER employee_compensation_run_line_immutable BEFORE UPDATE OR DELETE ON employee_compensation_run_line
 FOR EACH ROW EXECUTE FUNCTION app_prevent_ledger_mutation();
CREATE TRIGGER employee_compensation_run_cancellation_immutable BEFORE UPDATE OR DELETE ON employee_compensation_run_cancellation
 FOR EACH ROW EXECUTE FUNCTION app_prevent_ledger_mutation();

CREATE FUNCTION app_employee_compensation_run_admission() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE policy config_rule%ROWTYPE; point timestamptz;
BEGIN
 point=clock_timestamp();
 SELECT * INTO policy FROM config_rule WHERE organization_id=NEW.organization_id AND id=NEW.policy_rule_id;
 IF policy.id IS NULL OR policy.key<>'staff.compensation_runs' OR policy.scope_type<>'organization' OR policy.scope_id IS NOT NULL
  OR policy.archived_at IS NOT NULL OR policy.lifecycle<>'ACTIVE' OR policy.effective_from>point OR policy.effective_to<=point
  OR policy.value->>'earning_date' IS DISTINCT FROM 'RECORDED_COMPLETION' OR policy.value->>'timezone' IS DISTINCT FROM NEW.timezone
  OR NOT EXISTS(SELECT 1 FROM pg_timezone_names WHERE name=NEW.timezone)
  OR policy.value->>'max_period_days' IS NULL OR (policy.value->>'max_period_days')::integer<=0
  OR (NEW.to_on-NEW.from_on+1)>(policy.value->>'max_period_days')::integer
  OR NEW.policy_snapshot->>'schemaVersion' IS DISTINCT FROM '1' OR NEW.policy_snapshot->>'policyRuleId' IS DISTINCT FROM policy.id::text
  OR NEW.policy_snapshot->>'policyVersion' IS DISTINCT FROM policy.version::text OR NEW.policy_snapshot->'value' IS DISTINCT FROM policy.value
 THEN RAISE EXCEPTION 'compensation run requires its actual configured recorded-completion calendar'; END IF;
 NEW.created_at=point;RETURN NEW;
END $$;
CREATE TRIGGER employee_compensation_run_admission BEFORE INSERT ON employee_compensation_run
 FOR EACH ROW EXECUTE FUNCTION app_employee_compensation_run_admission();

CREATE FUNCTION app_employee_compensation_run_line_admission() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE run employee_compensation_run%ROWTYPE; task operation_task%ROWTYPE; event operation_task_event%ROWTYPE;
 assignment role_assignment%ROWTYPE; contract team_compensation%ROWTYPE; rule config_rule%ROWTYPE; selected config_rule%ROWTYPE;
 subject person%ROWTYPE; villa property%ROWTYPE; role_key text;
BEGIN
 SELECT * INTO run FROM employee_compensation_run WHERE organization_id=NEW.organization_id AND id=NEW.run_id;
 SELECT * INTO task FROM operation_task WHERE organization_id=NEW.organization_id AND id=NEW.task_id;
 SELECT * INTO event FROM operation_task_event WHERE organization_id=NEW.organization_id AND id=NEW.completion_event_id;
 SELECT * INTO assignment FROM role_assignment WHERE organization_id=NEW.organization_id AND id=NEW.assignment_id;
 SELECT * INTO contract FROM team_compensation WHERE organization_id=NEW.organization_id AND id=NEW.compensation_id;
 SELECT * INTO rule FROM config_rule WHERE organization_id=NEW.organization_id AND id=NEW.config_rule_id;
 SELECT * INTO subject FROM person WHERE organization_id=NEW.organization_id AND id=NEW.person_id;
 SELECT * INTO villa FROM property WHERE organization_id=NEW.organization_id AND id=NEW.property_id;
 SELECT key INTO role_key FROM role WHERE organization_id=NEW.organization_id AND id=assignment.role_id;
 IF run.id IS NULL OR task.id IS NULL OR event.id IS NULL OR assignment.id IS NULL OR contract.id IS NULL OR rule.id IS NULL OR subject.id IS NULL OR villa.id IS NULL
  OR EXISTS(SELECT 1 FROM employee_compensation_run_cancellation WHERE organization_id=NEW.organization_id AND run_id=run.id)
  OR task.state<>'COMPLETED' OR task.completed_at IS NULL OR task.completed_by_person_id IS DISTINCT FROM subject.id OR task.property_id<>villa.id
  OR NEW.recorded_completion_at IS DISTINCT FROM date_trunc('milliseconds',task.completed_at) OR NEW.currency<>run.currency
  OR (NEW.recorded_completion_at AT TIME ZONE run.timezone)::date NOT BETWEEN run.from_on AND run.to_on
  OR assignment.person_id<>subject.id OR contract.assignment_id<>assignment.id OR contract.config_rule_id<>rule.id OR contract.mode<>'PER_JOB'
  OR contract.currency<>NEW.currency OR contract.amount<>NEW.rate OR NEW.amount<>contract.amount OR contract.effective_from>task.completed_at
  OR assignment.valid_from>task.completed_at OR assignment.valid_to<=task.completed_at OR assignment.archived_at<=task.completed_at OR subject.archived_at<=task.completed_at
  OR EXISTS(SELECT 1 FROM team_compensation later WHERE later.organization_id=NEW.organization_id AND later.assignment_id=assignment.id
    AND later.effective_from<=task.completed_at AND later.version>contract.version)
  OR (assignment.scope_type='organization' AND assignment.scope_id IS NULL
    OR assignment.scope_type='property' AND assignment.scope_id=villa.id
    OR assignment.scope_type='city' AND assignment.scope_id=villa.city_id
    OR assignment.scope_type='region' AND assignment.scope_id=villa.region_id
    OR assignment.scope_type='job' AND assignment.scope_id=task.id) IS NOT TRUE
  OR task.required_role_key IS NOT NULL AND task.required_role_key IS DISTINCT FROM role_key
 THEN RAISE EXCEPTION 'compensation run line requires its actual performer contract, scope and recorded completed job'; END IF;
 SELECT * INTO selected FROM config_rule WHERE organization_id=NEW.organization_id AND key='staff.compensation'
  AND scope_type='role_assignment' AND scope_id=assignment.id AND archived_at IS NULL AND lifecycle IN('ACTIVE','RETIRED')
  AND effective_from<=task.completed_at AND (effective_to IS NULL OR effective_to>task.completed_at)
  ORDER BY effective_from DESC,version DESC LIMIT 1;
 IF selected.id IS DISTINCT FROM rule.id OR selected.lifecycle IS DISTINCT FROM 'ACTIVE' OR rule.effective_from IS DISTINCT FROM contract.effective_from
  OR rule.value->>'mode' IS DISTINCT FROM contract.mode OR rule.value->>'currency' IS DISTINCT FROM contract.currency::text
  OR (rule.value->>'amount')::numeric IS DISTINCT FROM contract.amount
 THEN RAISE EXCEPTION 'compensation run rate requires its actual effective contract configuration'; END IF;
 IF event.task_id<>task.id OR event.kind<>'CHANGED' OR event.version>task.version OR event.actor_id IS NULL
  OR event.after->>'state' IS DISTINCT FROM 'COMPLETED' OR event.before->>'state' IS NULL OR event.before->>'state'='COMPLETED'
  OR (SELECT count(*) FROM operation_task_event e WHERE e.organization_id=NEW.organization_id AND e.task_id=task.id
    AND e.kind='CHANGED' AND e.after->>'state'='COMPLETED' AND e.before->>'state' IS DISTINCT FROM 'COMPLETED')<>1
  OR event.after->>'id' IS DISTINCT FROM task.id::text OR event.after->>'organization_id' IS DISTINCT FROM NEW.organization_id::text
  OR event.after->>'property_id' IS DISTINCT FROM villa.id::text OR event.after->>'version' IS DISTINCT FROM event.version::text
  OR event.after->>'completed_by_person_id' IS DISTINCT FROM subject.id::text
  OR event.after->>'completed_by_user_account_id' IS DISTINCT FROM task.completed_by_user_account_id::text
  OR date_trunc('milliseconds',(event.after->>'completed_at')::timestamptz) IS DISTINCT FROM NEW.recorded_completion_at
  OR event.after->>'completion_idempotency_key' IS DISTINCT FROM task.completion_idempotency_key::text
  OR event.after->>'completion_source' IS DISTINCT FROM task.completion_source
  OR event.after->>'required_role_key' IS DISTINCT FROM task.required_role_key
  OR event.after->>'validated_by_person_id' IS DISTINCT FROM task.validated_by_person_id::text
  OR event.after->>'validated_by_user_account_id' IS DISTINCT FROM task.validated_by_user_account_id::text
  OR date_trunc('milliseconds',(event.after->>'validated_at')::timestamptz) IS DISTINCT FROM date_trunc('milliseconds',task.validated_at)
  OR event.after->>'validation_reason' IS DISTINCT FROM task.validation_reason
  OR (task.completion_source IN('SELF','OFFLINE_SYNC') AND task.completed_by_user_account_id=event.actor_id
    OR task.completion_source='PROXY' AND task.validated_by_user_account_id=event.actor_id AND task.validated_by_person_id<>subject.id
     AND task.validated_at IS NOT NULL AND length(btrim(task.validation_reason))>=6) IS NOT TRUE
  OR NOT EXISTS(SELECT 1 FROM operation_task_checklist_item WHERE organization_id=NEW.organization_id AND task_id=task.id)
  OR EXISTS(SELECT 1 FROM operation_task_checklist_item c WHERE c.organization_id=NEW.organization_id AND c.task_id=task.id
    AND(c.completed_at IS NULL OR c.completed_at>task.completed_at OR c.completed_by_person_id IS DISTINCT FROM task.completed_by_person_id
      OR c.completed_by_user_account_id IS DISTINCT FROM task.completed_by_user_account_id))
 THEN RAISE EXCEPTION 'compensation run completion requires its unique immutable event and attributed checklist'; END IF;
 IF NEW.source_snapshot->>'schemaVersion' IS DISTINCT FROM '1' OR NEW.source_snapshot->>'kind' IS DISTINCT FROM 'COMPLETED_JOB_ESTIMATE'
  OR NEW.source_snapshot->>'taskId' IS DISTINCT FROM task.id::text OR NEW.source_snapshot->>'personId' IS DISTINCT FROM subject.id::text
  OR NEW.source_snapshot->>'assignmentId' IS DISTINCT FROM assignment.id::text OR NEW.source_snapshot->>'compensationId' IS DISTINCT FROM contract.id::text
  OR NEW.source_snapshot->>'compensationVersion' IS DISTINCT FROM contract.version::text
  OR NEW.source_snapshot->>'configRuleId' IS DISTINCT FROM rule.id::text OR NEW.source_snapshot->>'configVersion' IS DISTINCT FROM rule.version::text
  OR NEW.source_snapshot->>'completionEventId' IS DISTINCT FROM event.id::text OR NEW.source_snapshot->>'completionVersion' IS DISTINCT FROM event.version::text
  OR NEW.source_snapshot->'completionEvent'->'after' IS DISTINCT FROM event.after
  OR NEW.source_snapshot->'basis' IS DISTINCT FROM '{"mode":"PER_JOB","jobs":"1"}'::jsonb
  OR NEW.source_snapshot->'rate' IS DISTINCT FROM jsonb_build_object('amount',NEW.rate::text,'currency',NEW.currency)
  OR NEW.source_snapshot->'amount' IS DISTINCT FROM jsonb_build_object('amount',NEW.amount::text,'currency',NEW.currency)
  OR NEW.source_snapshot->'contractRule'->'value' IS DISTINCT FROM rule.value
 THEN RAISE EXCEPTION 'compensation run snapshot must retain its exact immutable source and contractual amount'; END IF;
 NEW.created_at=clock_timestamp();RETURN NEW;
END $$;
CREATE TRIGGER employee_compensation_run_line_admission BEFORE INSERT ON employee_compensation_run_line
 FOR EACH ROW EXECUTE FUNCTION app_employee_compensation_run_line_admission();

CREATE FUNCTION app_employee_compensation_run_complete() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE run employee_compensation_run%ROWTYPE; line_count integer; total numeric;
BEGIN
 IF TG_TABLE_NAME='employee_compensation_run' THEN SELECT * INTO run FROM employee_compensation_run WHERE organization_id=NEW.organization_id AND id=NEW.id;
 ELSE SELECT * INTO run FROM employee_compensation_run WHERE organization_id=NEW.organization_id AND id=NEW.run_id; END IF;
 SELECT count(*),sum(amount) INTO line_count,total FROM employee_compensation_run_line WHERE organization_id=run.organization_id AND run_id=run.id;
 IF line_count=0 OR (SELECT count(*) FROM audit_log a WHERE a.organization_id=run.organization_id AND a.resource_type='employee_compensation_run'
  AND a.resource_id=run.id AND a.action='finance.employee_compensation_run.created')<>1
  OR NOT EXISTS(SELECT 1 FROM outbox_event e WHERE e.organization_id=run.organization_id AND e.type='EmployeeCompensationRunCreated'
    AND e.idempotency_key='employee-compensation-run:'||run.id::text||':created' AND e.payload=jsonb_build_object('runId',run.id::text))
  OR NOT EXISTS(SELECT 1 FROM audit_log a WHERE a.organization_id=run.organization_id AND a.resource_type='employee_compensation_run'
  AND a.resource_id=run.id AND a.action='finance.employee_compensation_run.created' AND a.actor_id=run.created_by AND a.reason=run.reason
  AND a.after->>'runId'=run.id::text AND a.after->>'kind'='COMPLETED_WORK_DRAFT' AND (a.after->>'lineCount')::integer=line_count
  AND (a.after#>>'{total,amount}')::numeric=total AND a.after#>>'{total,currency}'=run.currency)
 THEN RAISE EXCEPTION 'compensation run requires all actual source lines and its attributed atomic creation audit'; END IF;
 RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER employee_compensation_run_complete AFTER INSERT ON employee_compensation_run
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app_employee_compensation_run_complete();
CREATE CONSTRAINT TRIGGER employee_compensation_run_line_complete AFTER INSERT ON employee_compensation_run_line
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app_employee_compensation_run_complete();

CREATE FUNCTION app_employee_compensation_run_cancellation_complete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF (SELECT count(*) FROM audit_log a WHERE a.organization_id=NEW.organization_id AND a.resource_type='employee_compensation_run'
  AND a.resource_id=NEW.run_id AND a.action='finance.employee_compensation_run.cancelled')<>1
  OR NOT EXISTS(SELECT 1 FROM outbox_event e WHERE e.organization_id=NEW.organization_id AND e.type='EmployeeCompensationRunCancelled'
    AND e.idempotency_key='employee-compensation-run:'||NEW.run_id::text||':cancelled' AND e.payload=jsonb_build_object('runId',NEW.run_id::text))
  OR NOT EXISTS(SELECT 1 FROM audit_log a WHERE a.organization_id=NEW.organization_id AND a.resource_type='employee_compensation_run'
  AND a.resource_id=NEW.run_id AND a.action='finance.employee_compensation_run.cancelled' AND a.actor_id=NEW.cancelled_by AND a.reason=NEW.reason
  AND a.after->>'runId'=NEW.run_id::text AND a.after->>'cancellationId'=NEW.id::text)
 THEN RAISE EXCEPTION 'compensation run cancellation requires its actual attributed atomic audit'; END IF;
 RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER employee_compensation_run_cancellation_complete AFTER INSERT ON employee_compensation_run_cancellation
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app_employee_compensation_run_cancellation_complete();

COMMIT;
