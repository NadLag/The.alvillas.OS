-- CreateTable
CREATE TABLE "employee_work_time_evidence" (
    "id" UUID NOT NULL DEFAULT app_uuid_v7(),
    "organization_id" UUID NOT NULL,
    "task_id" UUID NOT NULL,
    "property_id" UUID NOT NULL,
    "completion_event_id" UUID NOT NULL,
    "performed_by_person_id" UUID NOT NULL,
    "submitted_by_account_id" UUID NOT NULL,
    "submitted_by_person_id" UUID NOT NULL,
    "policy_rule_id" UUID NOT NULL,
    "previous_evidence_id" UUID,
    "version" INTEGER NOT NULL,
    "kind" VARCHAR(24) NOT NULL,
    "idempotency_key" UUID NOT NULL,
    "request_fingerprint" CHAR(64) NOT NULL,
    "source_snapshot" JSONB NOT NULL,
    "policy_snapshot" JSONB NOT NULL,
    "reason" VARCHAR(1000) NOT NULL,
    "submitted_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "employee_work_time_evidence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "employee_work_time_interval" (
    "id" UUID NOT NULL DEFAULT app_uuid_v7(),
    "organization_id" UUID NOT NULL,
    "evidence_id" UUID NOT NULL,
    "position" INTEGER NOT NULL,
    "starts_at" TIMESTAMPTZ(3) NOT NULL,
    "ends_at" TIMESTAMPTZ(3) NOT NULL,
    "note" VARCHAR(1000),

    CONSTRAINT "employee_work_time_interval_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "employee_work_time_decision" (
    "id" UUID NOT NULL DEFAULT app_uuid_v7(),
    "organization_id" UUID NOT NULL,
    "evidence_id" UUID NOT NULL,
    "decided_by_account_id" UUID NOT NULL,
    "decided_by_person_id" UUID NOT NULL,
    "verdict" VARCHAR(24) NOT NULL,
    "idempotency_key" UUID NOT NULL,
    "request_fingerprint" CHAR(64) NOT NULL,
    "reason" VARCHAR(1000) NOT NULL,
    "decided_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "employee_work_time_decision_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "employee_work_time_property_history_idx" ON "employee_work_time_evidence"("organization_id", "property_id", "submitted_at" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "employee_work_time_person_history_idx" ON "employee_work_time_evidence"("organization_id", "performed_by_person_id", "submitted_at" DESC, "id" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "employee_work_time_evidence_org_id_unique" ON "employee_work_time_evidence"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "employee_work_time_evidence_nonce_unique" ON "employee_work_time_evidence"("organization_id", "idempotency_key");

-- CreateIndex
CREATE UNIQUE INDEX "employee_work_time_evidence_version_unique" ON "employee_work_time_evidence"("organization_id", "task_id", "performed_by_person_id", "version");

-- CreateIndex
CREATE INDEX "employee_work_time_interval_evidence_idx" ON "employee_work_time_interval"("organization_id", "evidence_id", "starts_at");

-- CreateIndex
CREATE UNIQUE INDEX "employee_work_time_interval_org_id_unique" ON "employee_work_time_interval"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "employee_work_time_interval_position_unique" ON "employee_work_time_interval"("organization_id", "evidence_id", "position");

-- CreateIndex
CREATE UNIQUE INDEX "employee_work_time_decision_org_id_unique" ON "employee_work_time_decision"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "employee_work_time_decision_once_unique" ON "employee_work_time_decision"("organization_id", "evidence_id");

-- CreateIndex
CREATE UNIQUE INDEX "employee_work_time_decision_nonce_unique" ON "employee_work_time_decision"("organization_id", "idempotency_key");

-- AddForeignKey
ALTER TABLE "employee_work_time_evidence" ADD CONSTRAINT "employee_work_time_evidence_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "employee_work_time_evidence" ADD CONSTRAINT "employee_work_time_evidence_organization_id_task_id_fkey" FOREIGN KEY ("organization_id", "task_id") REFERENCES "operation_task"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "employee_work_time_evidence" ADD CONSTRAINT "employee_work_time_evidence_organization_id_property_id_fkey" FOREIGN KEY ("organization_id", "property_id") REFERENCES "property"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "employee_work_time_evidence" ADD CONSTRAINT "employee_work_time_evidence_organization_id_completion_eve_fkey" FOREIGN KEY ("organization_id", "completion_event_id") REFERENCES "operation_task_event"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "employee_work_time_evidence" ADD CONSTRAINT "employee_work_time_evidence_organization_id_performed_by_p_fkey" FOREIGN KEY ("organization_id", "performed_by_person_id") REFERENCES "person"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "employee_work_time_evidence" ADD CONSTRAINT "employee_work_time_evidence_organization_id_submitted_by_a_fkey" FOREIGN KEY ("organization_id", "submitted_by_account_id") REFERENCES "user_account"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "employee_work_time_evidence" ADD CONSTRAINT "employee_work_time_evidence_organization_id_submitted_by_p_fkey" FOREIGN KEY ("organization_id", "submitted_by_person_id") REFERENCES "person"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "employee_work_time_evidence" ADD CONSTRAINT "employee_work_time_evidence_organization_id_policy_rule_id_fkey" FOREIGN KEY ("organization_id", "policy_rule_id") REFERENCES "config_rule"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "employee_work_time_evidence" ADD CONSTRAINT "employee_work_time_evidence_organization_id_previous_evide_fkey" FOREIGN KEY ("organization_id", "previous_evidence_id") REFERENCES "employee_work_time_evidence"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "employee_work_time_interval" ADD CONSTRAINT "employee_work_time_interval_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "employee_work_time_interval" ADD CONSTRAINT "employee_work_time_interval_organization_id_evidence_id_fkey" FOREIGN KEY ("organization_id", "evidence_id") REFERENCES "employee_work_time_evidence"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "employee_work_time_decision" ADD CONSTRAINT "employee_work_time_decision_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "employee_work_time_decision" ADD CONSTRAINT "employee_work_time_decision_organization_id_evidence_id_fkey" FOREIGN KEY ("organization_id", "evidence_id") REFERENCES "employee_work_time_evidence"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "employee_work_time_decision" ADD CONSTRAINT "employee_work_time_decision_organization_id_decided_by_acc_fkey" FOREIGN KEY ("organization_id", "decided_by_account_id") REFERENCES "user_account"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "employee_work_time_decision" ADD CONSTRAINT "employee_work_time_decision_organization_id_decided_by_per_fkey" FOREIGN KEY ("organization_id", "decided_by_person_id") REFERENCES "person"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

ALTER TABLE employee_work_time_evidence ADD CONSTRAINT employee_work_time_evidence_shape CHECK ((
 version>0 AND kind IN('ACTUAL_INTERVALS','CANCELLATION') AND request_fingerprint~'^[a-f0-9]{64}$'
 AND length(btrim(reason)) BETWEEN 6 AND 1000 AND jsonb_typeof(source_snapshot)='object' AND jsonb_typeof(policy_snapshot)='object'
 AND ((version=1 AND previous_evidence_id IS NULL AND kind='ACTUAL_INTERVALS') OR (version>1 AND previous_evidence_id IS NOT NULL))
) IS TRUE);
ALTER TABLE employee_work_time_interval ADD CONSTRAINT employee_work_time_interval_shape CHECK ((position>=0 AND starts_at<ends_at AND (note IS NULL OR length(note)<=1000)) IS TRUE);
ALTER TABLE employee_work_time_decision ADD CONSTRAINT employee_work_time_decision_shape CHECK ((verdict IN('APPROVED','REJECTED') AND request_fingerprint~'^[a-f0-9]{64}$' AND length(btrim(reason)) BETWEEN 6 AND 1000) IS TRUE);

CREATE FUNCTION app_assert_employee_work_time_source(q employee_work_time_evidence,is_new boolean) RETURNS void
LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE t operation_task%ROWTYPE; e operation_task_event%ROWTYPE; p config_rule%ROWTYPE; a user_account%ROWTYPE; prior employee_work_time_evidence%ROWTYPE; canonical uuid;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended(q.organization_id::text||':employee-work-time:'||q.task_id::text||':'||q.performed_by_person_id::text,0));
 SELECT * INTO t FROM operation_task WHERE organization_id=q.organization_id AND id=q.task_id;
 SELECT * INTO e FROM operation_task_event WHERE organization_id=q.organization_id AND id=q.completion_event_id AND task_id=q.task_id;
 SELECT * INTO p FROM config_rule WHERE organization_id=q.organization_id AND id=q.policy_rule_id;
 IF t.id IS NULL OR e.id IS NULL OR t.property_id IS DISTINCT FROM q.property_id OR t.state IS DISTINCT FROM 'COMPLETED'
  OR t.completed_by_person_id IS DISTINCT FROM q.performed_by_person_id OR t.completed_at IS NULL
  OR e.kind IS DISTINCT FROM 'CHANGED' OR e.after->>'state' IS DISTINCT FROM 'COMPLETED' OR e.before->>'state' IS NULL OR e.before->>'state'='COMPLETED'
  OR t.completion_source IS NULL OR t.completion_source NOT IN('SELF','OFFLINE_SYNC','PROXY')
  OR e.actor_id IS NULL OR e.version>t.version OR e.after IS DISTINCT FROM q.source_snapshot
  OR (q.source_snapshot->>'id')::uuid IS DISTINCT FROM t.id OR (q.source_snapshot->>'organization_id')::uuid IS DISTINCT FROM q.organization_id
  OR (q.source_snapshot->>'property_id')::uuid IS DISTINCT FROM t.property_id OR (q.source_snapshot->>'version')::integer IS DISTINCT FROM e.version
  OR (q.source_snapshot->>'completed_at')::timestamptz IS DISTINCT FROM t.completed_at
  OR (q.source_snapshot->>'completed_by_person_id')::uuid IS DISTINCT FROM t.completed_by_person_id
  OR (q.source_snapshot->>'completed_by_user_account_id')::uuid IS DISTINCT FROM t.completed_by_user_account_id
  OR (q.source_snapshot->>'completion_idempotency_key')::uuid IS DISTINCT FROM t.completion_idempotency_key
  OR q.source_snapshot->>'completion_source' IS DISTINCT FROM t.completion_source
  OR q.source_snapshot->>'required_role_key' IS DISTINCT FROM t.required_role_key
  OR (q.source_snapshot->>'validated_by_person_id')::uuid IS DISTINCT FROM t.validated_by_person_id
  OR (q.source_snapshot->>'validated_by_user_account_id')::uuid IS DISTINCT FROM t.validated_by_user_account_id
  OR (q.source_snapshot->>'validated_at')::timestamptz IS DISTINCT FROM t.validated_at
  OR q.source_snapshot->>'validation_reason' IS DISTINCT FROM t.validation_reason
  OR NOT EXISTS(SELECT 1 FROM user_account WHERE organization_id=q.organization_id AND id=e.actor_id)
  OR NOT EXISTS(SELECT 1 FROM operation_task_checklist_item WHERE organization_id=q.organization_id AND task_id=t.id)
  OR EXISTS(SELECT 1 FROM operation_task_checklist_item item WHERE item.organization_id=q.organization_id AND item.task_id=t.id
    AND (item.completed_at IS NULL OR item.completed_at>t.completed_at OR item.completed_by_person_id IS DISTINCT FROM t.completed_by_person_id OR item.completed_by_user_account_id IS DISTINCT FROM t.completed_by_user_account_id))
 THEN RAISE EXCEPTION 'work time requires the actual coherent performer, completion and completed checklist';END IF;
 IF t.completion_source='PROXY' THEN
  IF t.validated_by_person_id IS NULL OR t.validated_by_person_id=t.completed_by_person_id OR t.validated_by_user_account_id IS DISTINCT FROM e.actor_id
   OR t.validated_at IS NULL OR coalesce(length(btrim(t.validation_reason)),0)<6 THEN RAISE EXCEPTION 'proxy work time requires its actual distinct completion validator';END IF;
 ELSIF t.completion_source NOT IN('SELF','OFFLINE_SYNC') OR t.completed_by_user_account_id IS DISTINCT FROM e.actor_id THEN
  RAISE EXCEPTION 'direct work time requires its actual completion actor';
 END IF;
 IF p.id IS NULL OR p.key<>'staff.compensation_hourly_earnings' OR p.scope_type<>'organization' OR p.scope_id IS NOT NULL
  OR p.value IS DISTINCT FROM q.policy_snapshot OR p.effective_from>q.submitted_at
  OR (q.policy_snapshot->>'evidence'='VALIDATED_COMPLETED_WORK_INTERVALS' AND q.policy_snapshot->>'rate_selection'='ACTUAL_EFFECTIVE_INSTANTS'
    AND q.policy_snapshot->>'rounding'='HALF_UP_AT_EARNING_TOTAL' AND q.policy_snapshot->>'max_interval_seconds'~'^[1-9][0-9]{0,29}$'
    AND q.policy_snapshot->>'max_total_seconds'~'^[1-9][0-9]{0,29}$' AND jsonb_typeof(q.policy_snapshot->'require_distinct_validator')='boolean'
    AND (q.policy_snapshot-'evidence'-'rate_selection'-'rounding'-'max_interval_seconds'-'max_total_seconds'-'require_distinct_validator')='{}'::jsonb) IS NOT TRUE
 THEN RAISE EXCEPTION 'work time requires the original explicit tenant policy';END IF;
 IF is_new THEN
  SELECT * INTO a FROM user_account WHERE organization_id=q.organization_id AND id=q.submitted_by_account_id;
  IF a.id IS NULL OR a.status<>'ACTIVE' OR a.person_id IS DISTINCT FROM q.submitted_by_person_id THEN RAISE EXCEPTION 'work time requires its actual active recording identity';END IF;
  SELECT id INTO canonical FROM config_rule WHERE organization_id=q.organization_id AND key=p.key AND scope_type='organization' AND scope_id IS NULL
   AND lifecycle='ACTIVE' AND effective_from<=q.submitted_at AND (effective_to IS NULL OR effective_to>q.submitted_at)
   ORDER BY effective_from DESC,version DESC LIMIT 1;
  IF canonical IS DISTINCT FROM p.id THEN RAISE EXCEPTION 'new work time requires the canonical current policy';END IF;
  IF q.version=1 THEN
   IF EXISTS(SELECT 1 FROM employee_work_time_evidence WHERE organization_id=q.organization_id AND task_id=q.task_id AND performed_by_person_id=q.performed_by_person_id) THEN RAISE EXCEPTION 'work time history already exists';END IF;
  ELSE
   SELECT * INTO prior FROM employee_work_time_evidence WHERE organization_id=q.organization_id AND id=q.previous_evidence_id;
   IF prior.id IS NULL OR prior.task_id IS DISTINCT FROM q.task_id OR prior.property_id IS DISTINCT FROM q.property_id OR prior.completion_event_id IS DISTINCT FROM q.completion_event_id
    OR prior.performed_by_person_id IS DISTINCT FROM q.performed_by_person_id OR prior.version<>q.version-1
    OR prior.version IS DISTINCT FROM (SELECT max(version) FROM employee_work_time_evidence WHERE organization_id=q.organization_id AND task_id=q.task_id AND performed_by_person_id=q.performed_by_person_id)
    OR (prior.kind='CANCELLATION' AND q.kind='CANCELLATION') THEN RAISE EXCEPTION 'work time revisions require their actual latest predecessor';END IF;
  END IF;
 END IF;
END $$;

CREATE FUNCTION app_employee_work_time_admission() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended(NEW.organization_id::text||':employee-work-time:'||NEW.task_id::text||':'||NEW.performed_by_person_id::text,0));
 NEW.submitted_at=date_trunc('milliseconds',clock_timestamp());PERFORM app_assert_employee_work_time_source(NEW,true);RETURN NEW;
END $$;
CREATE TRIGGER employee_work_time_admission BEFORE INSERT ON employee_work_time_evidence FOR EACH ROW EXECUTE FUNCTION app_employee_work_time_admission();

CREATE FUNCTION app_employee_work_time_complete() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE q employee_work_time_evidence%ROWTYPE; born xid; total_ms numeric; count_intervals integer;
BEGIN
 SELECT * INTO q FROM employee_work_time_evidence WHERE organization_id=NEW.organization_id AND id=NEW.id;
 SELECT xmin INTO born FROM employee_work_time_evidence WHERE organization_id=NEW.organization_id AND id=NEW.id;
 SELECT count(*),coalesce(sum(extract(epoch FROM ends_at-starts_at)*1000),0) INTO count_intervals,total_ms FROM employee_work_time_interval WHERE organization_id=q.organization_id AND evidence_id=q.id;
 IF (q.kind='ACTUAL_INTERVALS' AND count_intervals=0) OR (q.kind='CANCELLATION' AND count_intervals<>0)
  OR total_ms>(q.policy_snapshot->>'max_total_seconds')::numeric*1000
  OR EXISTS(SELECT 1 FROM employee_work_time_interval i WHERE i.organization_id=q.organization_id AND i.evidence_id=q.id
    AND (i.xmin<>born OR i.ends_at>(q.source_snapshot->>'completed_at')::timestamptz OR extract(epoch FROM i.ends_at-i.starts_at)>(q.policy_snapshot->>'max_interval_seconds')::numeric))
  OR EXISTS(SELECT 1 FROM employee_work_time_interval a JOIN employee_work_time_interval b ON b.organization_id=a.organization_id AND b.evidence_id=a.evidence_id AND b.id>a.id
    WHERE a.organization_id=q.organization_id AND a.evidence_id=q.id AND a.starts_at<b.ends_at AND b.starts_at<a.ends_at)
  OR (count_intervals>0 AND ((SELECT min(position) FROM employee_work_time_interval WHERE organization_id=q.organization_id AND evidence_id=q.id)<>0
    OR (SELECT max(position) FROM employee_work_time_interval WHERE organization_id=q.organization_id AND evidence_id=q.id)<>count_intervals-1))
 THEN RAISE EXCEPTION 'work time requires complete original nonoverlapping policy-bounded intervals';END IF;
 IF (SELECT count(*) FROM audit_log a WHERE a.organization_id=q.organization_id AND a.resource_type='task' AND a.resource_id=q.task_id AND a.property_scope_id=q.property_id
   AND a.actor_id=q.submitted_by_account_id AND a.action='operations.work_time.submitted' AND a.reason=q.reason AND a.xmin=born
   AND a.after=jsonb_build_object('evidenceId',q.id::text,'version',q.version,'kind',q.kind,'intervalCount',count_intervals))<>1
  OR NOT EXISTS(SELECT 1 FROM outbox_event e WHERE e.organization_id=q.organization_id AND e.type='EmployeeWorkTimeSubmitted' AND e.xmin=born
   AND e.idempotency_key='employee-work-time:'||q.id::text||':submitted' AND e.payload=jsonb_build_object('evidenceId',q.id::text,'taskId',q.task_id::text,'version',q.version) AND e.occurred_at=q.submitted_at)
 THEN RAISE EXCEPTION 'work time requires its atomic private audit and outbox attribution';END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER employee_work_time_complete AFTER INSERT ON employee_work_time_evidence DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app_employee_work_time_complete();

CREATE FUNCTION app_employee_work_time_interval_complete() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE parent_born xid; interval_born xid;
BEGIN
 SELECT xmin INTO parent_born FROM employee_work_time_evidence WHERE organization_id=NEW.organization_id AND id=NEW.evidence_id;
 SELECT xmin INTO interval_born FROM employee_work_time_interval WHERE organization_id=NEW.organization_id AND id=NEW.id;
 IF parent_born IS NULL OR parent_born IS DISTINCT FROM interval_born THEN RAISE EXCEPTION 'work time intervals cannot be appended to historical evidence';END IF;RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER employee_work_time_interval_complete AFTER INSERT ON employee_work_time_interval DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app_employee_work_time_interval_complete();

CREATE FUNCTION app_employee_work_time_decision_admission() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE q employee_work_time_evidence%ROWTYPE; actor user_account%ROWTYPE;
BEGIN
 SELECT * INTO q FROM employee_work_time_evidence WHERE organization_id=NEW.organization_id AND id=NEW.evidence_id;
 IF q.id IS NULL THEN RAISE EXCEPTION 'work time decision requires actual tenant evidence';END IF;
 PERFORM app_assert_employee_work_time_source(q,false);
 SELECT * INTO actor FROM user_account WHERE organization_id=NEW.organization_id AND id=NEW.decided_by_account_id;
 IF actor.id IS NULL OR actor.status<>'ACTIVE' OR actor.person_id IS DISTINCT FROM NEW.decided_by_person_id
  OR q.version IS DISTINCT FROM (SELECT max(version) FROM employee_work_time_evidence WHERE organization_id=q.organization_id AND task_id=q.task_id AND performed_by_person_id=q.performed_by_person_id)
  OR ((q.policy_snapshot->>'require_distinct_validator')::boolean AND NEW.decided_by_person_id=q.performed_by_person_id)
 THEN RAISE EXCEPTION 'work time decisions require a current actual policy-authorized validator and latest evidence';END IF;
 NEW.decided_at=date_trunc('milliseconds',clock_timestamp());IF NEW.decided_at<q.submitted_at THEN RAISE EXCEPTION 'work time decisions cannot precede submission';END IF;RETURN NEW;
END $$;
CREATE TRIGGER employee_work_time_decision_admission BEFORE INSERT ON employee_work_time_decision FOR EACH ROW EXECUTE FUNCTION app_employee_work_time_decision_admission();

CREATE FUNCTION app_employee_work_time_decision_complete() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE d employee_work_time_decision%ROWTYPE; q employee_work_time_evidence%ROWTYPE; born xid;
BEGIN
 SELECT * INTO d FROM employee_work_time_decision WHERE organization_id=NEW.organization_id AND id=NEW.id;
 SELECT xmin INTO born FROM employee_work_time_decision WHERE organization_id=NEW.organization_id AND id=NEW.id;
 SELECT * INTO q FROM employee_work_time_evidence WHERE organization_id=d.organization_id AND id=d.evidence_id;
 IF (SELECT count(*) FROM audit_log a WHERE a.organization_id=d.organization_id AND a.resource_type='task' AND a.resource_id=q.task_id AND a.property_scope_id=q.property_id
   AND a.actor_id=d.decided_by_account_id AND a.action='operations.work_time.decided' AND a.reason=d.reason AND a.xmin=born
   AND a.after=jsonb_build_object('evidenceId',q.id::text,'decisionId',d.id::text,'verdict',d.verdict))<>1
  OR NOT EXISTS(SELECT 1 FROM outbox_event e WHERE e.organization_id=d.organization_id AND e.type='EmployeeWorkTimeDecided' AND e.xmin=born
   AND e.idempotency_key='employee-work-time-decision:'||d.id::text||':decided' AND e.payload=jsonb_build_object('evidenceId',q.id::text,'decisionId',d.id::text,'taskId',q.task_id::text,'verdict',d.verdict) AND e.occurred_at=d.decided_at)
 THEN RAISE EXCEPTION 'work time decisions require their atomic private audit and outbox';END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER employee_work_time_decision_complete AFTER INSERT ON employee_work_time_decision DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app_employee_work_time_decision_complete();

CREATE FUNCTION app_employee_work_time_outbox_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE q employee_work_time_evidence%ROWTYPE; d employee_work_time_decision%ROWTYPE;
BEGIN
 IF TG_OP='DELETE' THEN
  IF OLD.type IN('EmployeeWorkTimeSubmitted','EmployeeWorkTimeDecided') THEN RAISE EXCEPTION 'work time event references are immutable';END IF;RETURN OLD;
 END IF;
 IF TG_OP='UPDATE' AND (OLD.type IN('EmployeeWorkTimeSubmitted','EmployeeWorkTimeDecided') OR NEW.type IN('EmployeeWorkTimeSubmitted','EmployeeWorkTimeDecided')) THEN
  IF (OLD.id,OLD.organization_id,OLD.type,OLD.payload,OLD.idempotency_key,OLD.occurred_at) IS DISTINCT FROM (NEW.id,NEW.organization_id,NEW.type,NEW.payload,NEW.idempotency_key,NEW.occurred_at)
   THEN RAISE EXCEPTION 'work time event references are immutable';END IF;RETURN NEW;
 END IF;
 IF NEW.type='EmployeeWorkTimeSubmitted' THEN
  SELECT * INTO q FROM employee_work_time_evidence WHERE organization_id=NEW.organization_id AND id=(NEW.payload->>'evidenceId')::uuid;
  IF q.id IS NULL OR NEW.payload IS DISTINCT FROM jsonb_build_object('evidenceId',q.id::text,'taskId',q.task_id::text,'version',q.version)
   OR NEW.idempotency_key IS DISTINCT FROM 'employee-work-time:'||q.id::text||':submitted' OR NEW.occurred_at IS DISTINCT FROM q.submitted_at
   THEN RAISE EXCEPTION 'work time events require their actual immutable tenant source';END IF;
 ELSIF NEW.type='EmployeeWorkTimeDecided' THEN
  SELECT * INTO d FROM employee_work_time_decision WHERE organization_id=NEW.organization_id AND id=(NEW.payload->>'decisionId')::uuid;
  SELECT * INTO q FROM employee_work_time_evidence WHERE organization_id=NEW.organization_id AND id=d.evidence_id;
  IF d.id IS NULL OR q.id IS NULL OR NEW.payload IS DISTINCT FROM jsonb_build_object('evidenceId',q.id::text,'decisionId',d.id::text,'taskId',q.task_id::text,'verdict',d.verdict)
   OR NEW.idempotency_key IS DISTINCT FROM 'employee-work-time-decision:'||d.id::text||':decided' OR NEW.occurred_at IS DISTINCT FROM d.decided_at
   THEN RAISE EXCEPTION 'work time decision events require their actual immutable tenant source';END IF;
 END IF;RETURN NEW;
END $$;
CREATE TRIGGER employee_work_time_outbox_guard BEFORE INSERT OR UPDATE OR DELETE ON outbox_event FOR EACH ROW EXECUTE FUNCTION app_employee_work_time_outbox_guard();

DO $$ DECLARE table_name text; BEGIN
 FOREACH table_name IN ARRAY ARRAY['employee_work_time_evidence','employee_work_time_interval','employee_work_time_decision'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',table_name);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',table_name);
  EXECUTE format('CREATE POLICY %I ON %I USING(organization_id=NULLIF(current_setting(''app.current_organization_id'',true),'''')::uuid) WITH CHECK(organization_id=NULLIF(current_setting(''app.current_organization_id'',true),'''')::uuid)',table_name||'_tenant_isolation',table_name);
  EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION app_operation_immutable()',table_name||'_immutable',table_name);
 END LOOP;
END $$;

