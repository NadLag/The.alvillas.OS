BEGIN;
-- CreateTable
CREATE TABLE "employee_earning_run_request" (
    "id" UUID NOT NULL DEFAULT app_uuid_v7(),
    "organization_id" UUID NOT NULL,
    "requested_by" UUID NOT NULL,
    "earning_kind" VARCHAR(16) NOT NULL,
    "idempotency_key" UUID NOT NULL,
    "request_fingerprint" CHAR(64) NOT NULL,
    "reviewed_source_fingerprint" CHAR(64) NOT NULL,
    "policy_rule_id" UUID NOT NULL,
    "from_on" DATE NOT NULL,
    "to_on" DATE NOT NULL,
    "timezone" VARCHAR(80) NOT NULL,
    "currency" VARCHAR(3) NOT NULL,
    "amount" DECIMAL(128,2) NOT NULL,
    "input" JSONB NOT NULL,
    "policy_snapshot" JSONB NOT NULL,
    "authorization_cap" JSONB NOT NULL,
    "requested_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "employee_earning_run_request_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "employee_earning_request_work" (
    "id" UUID NOT NULL DEFAULT app_uuid_v7(),
    "organization_id" UUID NOT NULL,
    "request_id" UUID NOT NULL,
    "person_id" UUID NOT NULL,
    "assignment_id" UUID NOT NULL,
    "compensation_id" UUID NOT NULL,
    "config_rule_id" UUID NOT NULL,
    "evidence_id" UUID NOT NULL,
    "decision_id" UUID NOT NULL,
    "recorded_completion_at" TIMESTAMPTZ(3) NOT NULL,
    "currency" VARCHAR(3) NOT NULL,
    "rate" DECIMAL(18,2) NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "source_snapshot" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "employee_earning_request_work_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "employee_earning_request_hourly_witness" (
    "id" UUID NOT NULL DEFAULT app_uuid_v7(),
    "organization_id" UUID NOT NULL,
    "source_id" UUID NOT NULL,
    "interval_id" UUID NOT NULL,
    "compensation_id" UUID NOT NULL,
    "config_rule_id" UUID NOT NULL,
    "position" INTEGER NOT NULL,
    "starts_at" TIMESTAMPTZ(3) NOT NULL,
    "ends_at" TIMESTAMPTZ(3) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "employee_earning_request_hourly_witness_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "employee_earning_run_outcome" (
    "id" UUID NOT NULL DEFAULT app_uuid_v7(),
    "organization_id" UUID NOT NULL,
    "request_id" UUID NOT NULL,
    "run_id" UUID,
    "state" VARCHAR(16) NOT NULL,
    "failure_code" VARCHAR(80),
    "occurred_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "employee_earning_run_outcome_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "employee_earning_request_actor_idx" ON "employee_earning_run_request"("organization_id", "requested_by", "id");

-- CreateIndex
CREATE UNIQUE INDEX "employee_earning_run_request_organization_id_id_key" ON "employee_earning_run_request"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "employee_earning_request_nonce_unique" ON "employee_earning_run_request"("organization_id", "idempotency_key");

-- CreateIndex
CREATE INDEX "employee_earning_work_assignment_idx" ON "employee_earning_request_work"("organization_id", "assignment_id");

-- CreateIndex
CREATE UNIQUE INDEX "employee_earning_request_work_organization_id_id_key" ON "employee_earning_request_work"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "employee_earning_work_source_unique" ON "employee_earning_request_work"("organization_id", "request_id", "evidence_id");

-- CreateIndex
CREATE INDEX "employee_earning_witness_interval_idx" ON "employee_earning_request_hourly_witness"("organization_id", "interval_id");

-- CreateIndex
CREATE UNIQUE INDEX "employee_earning_request_hourly_witness_organization_id_id_key" ON "employee_earning_request_hourly_witness"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "employee_earning_witness_position_unique" ON "employee_earning_request_hourly_witness"("organization_id", "source_id", "position");

-- CreateIndex
CREATE UNIQUE INDEX "employee_earning_witness_interval_unique" ON "employee_earning_request_hourly_witness"("organization_id", "source_id", "interval_id", "starts_at");

-- CreateIndex
CREATE UNIQUE INDEX "employee_earning_run_outcome_organization_id_id_key" ON "employee_earning_run_outcome"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "employee_earning_outcome_request_unique" ON "employee_earning_run_outcome"("organization_id", "request_id");

-- CreateIndex
CREATE UNIQUE INDEX "employee_earning_outcome_run_unique" ON "employee_earning_run_outcome"("organization_id", "run_id");

-- AddForeignKey
ALTER TABLE "employee_earning_run_request" ADD CONSTRAINT "employee_earning_run_request_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "employee_earning_run_request" ADD CONSTRAINT "employee_earning_request_actor_fk" FOREIGN KEY ("organization_id", "requested_by") REFERENCES "user_account"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "employee_earning_run_request" ADD CONSTRAINT "employee_earning_request_policy_fk" FOREIGN KEY ("organization_id", "policy_rule_id") REFERENCES "config_rule"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "employee_earning_request_work" ADD CONSTRAINT "employee_earning_request_work_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "employee_earning_request_work" ADD CONSTRAINT "employee_earning_work_request_fk" FOREIGN KEY ("organization_id", "request_id") REFERENCES "employee_earning_run_request"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "employee_earning_request_work" ADD CONSTRAINT "employee_earning_work_person_fk" FOREIGN KEY ("organization_id", "person_id") REFERENCES "person"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "employee_earning_request_work" ADD CONSTRAINT "employee_earning_work_assignment_fk" FOREIGN KEY ("organization_id", "assignment_id") REFERENCES "role_assignment"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "employee_earning_request_work" ADD CONSTRAINT "employee_earning_work_contract_fk" FOREIGN KEY ("organization_id", "compensation_id") REFERENCES "team_compensation"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "employee_earning_request_work" ADD CONSTRAINT "employee_earning_work_config_fk" FOREIGN KEY ("organization_id", "config_rule_id") REFERENCES "config_rule"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "employee_earning_request_work" ADD CONSTRAINT "employee_earning_work_evidence_fk" FOREIGN KEY ("organization_id", "evidence_id") REFERENCES "employee_work_time_evidence"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "employee_earning_request_work" ADD CONSTRAINT "employee_earning_work_decision_fk" FOREIGN KEY ("organization_id", "decision_id") REFERENCES "employee_work_time_decision"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "employee_earning_request_hourly_witness" ADD CONSTRAINT "employee_earning_request_hourly_witness_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "employee_earning_request_hourly_witness" ADD CONSTRAINT "employee_earning_witness_source_fk" FOREIGN KEY ("organization_id", "source_id") REFERENCES "employee_earning_request_work"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "employee_earning_request_hourly_witness" ADD CONSTRAINT "employee_earning_witness_interval_fk" FOREIGN KEY ("organization_id", "interval_id") REFERENCES "employee_work_time_interval"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "employee_earning_request_hourly_witness" ADD CONSTRAINT "employee_earning_witness_contract_fk" FOREIGN KEY ("organization_id", "compensation_id") REFERENCES "team_compensation"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "employee_earning_request_hourly_witness" ADD CONSTRAINT "employee_earning_witness_config_fk" FOREIGN KEY ("organization_id", "config_rule_id") REFERENCES "config_rule"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "employee_earning_run_outcome" ADD CONSTRAINT "employee_earning_run_outcome_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "employee_earning_run_outcome" ADD CONSTRAINT "employee_earning_outcome_request_fk" FOREIGN KEY ("organization_id", "request_id") REFERENCES "employee_earning_run_request"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "employee_earning_run_outcome" ADD CONSTRAINT "employee_earning_outcome_run_fk" FOREIGN KEY ("organization_id", "run_id") REFERENCES "employee_compensation_run"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;


CREATE VIEW employee_hourly_contract_witness WITH(security_invoker=true,security_barrier=true) AS
 SELECT id,organization_id,'RUN'::text AS owner_kind,run_line_id AS owner_id,interval_id,compensation_id,config_rule_id,position,starts_at,ends_at,created_at,xmin AS row_birth FROM employee_compensation_hourly_witness
 UNION ALL
 SELECT id,organization_id,'REQUEST'::text AS owner_kind,source_id AS owner_id,interval_id,compensation_id,config_rule_id,position,starts_at,ends_at,created_at,xmin AS row_birth FROM employee_earning_request_hourly_witness;
CREATE OR REPLACE FUNCTION public.app_assert_employee_hourly_origin(v employee_compensation_run_line, h employee_compensation_run)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE q employee_work_time_evidence%ROWTYPE;d employee_work_time_decision%ROWTYPE;a role_assignment%ROWTYPE;c team_compensation%ROWTYPE;r config_rule%ROWTYPE;wp config_rule%ROWTYPE;rp config_rule%ROWTYPE;t operation_task%ROWTYPE;p property%ROWTYPE;role_key text;
BEGIN
 SELECT * INTO q FROM employee_work_time_evidence WHERE organization_id=v.organization_id AND id=v.work_time_evidence_id;
 SELECT * INTO d FROM employee_work_time_decision WHERE organization_id=v.organization_id AND id=v.work_time_decision_id;
 SELECT * INTO a FROM role_assignment WHERE organization_id=v.organization_id AND id=v.assignment_id;
 SELECT * INTO c FROM team_compensation WHERE organization_id=v.organization_id AND id=v.compensation_id;
 SELECT * INTO r FROM config_rule WHERE organization_id=v.organization_id AND id=v.config_rule_id;
 SELECT * INTO wp FROM config_rule WHERE organization_id=v.organization_id AND id=q.policy_rule_id;
 SELECT * INTO rp FROM config_rule WHERE organization_id=v.organization_id AND id=h.policy_rule_id;
 SELECT * INTO t FROM operation_task WHERE organization_id=v.organization_id AND id=v.task_id;
 SELECT * INTO p FROM property WHERE organization_id=v.organization_id AND id=v.property_id;
 SELECT key INTO role_key FROM role WHERE organization_id=v.organization_id AND id=a.role_id;
 IF h.id IS NULL OR h.earning_kind<>'PER_HOUR' OR v.earning_kind<>'PER_HOUR' OR q.id IS NULL OR d.id IS NULL OR a.id IS NULL OR c.id IS NULL OR r.id IS NULL OR wp.id IS NULL OR rp.id IS NULL OR t.id IS NULL OR p.id IS NULL
  OR q.kind<>'ACTUAL_INTERVALS' OR d.evidence_id<>q.id OR d.verdict<>'APPROVED' OR q.task_id<>t.id OR q.property_id<>p.id OR q.completion_event_id IS DISTINCT FROM v.completion_event_id
  OR q.performed_by_person_id<>v.person_id OR a.person_id<>v.person_id OR t.completed_by_person_id IS DISTINCT FROM v.person_id OR t.property_id<>p.id
  OR q.id IS DISTINCT FROM(SELECT x.id FROM employee_work_time_evidence x WHERE x.organization_id=v.organization_id AND x.task_id=q.task_id AND x.performed_by_person_id=q.performed_by_person_id ORDER BY x.version DESC LIMIT 1)
  OR v.recorded_completion_at IS DISTINCT FROM date_trunc('milliseconds',t.completed_at) OR (v.recorded_completion_at AT TIME ZONE h.timezone)::date NOT BETWEEN h.from_on AND h.to_on
  OR v.currency<>h.currency OR c.assignment_id<>a.id OR c.config_rule_id<>r.id OR c.mode<>'PER_HOUR' OR c.currency<>v.currency OR c.amount<>v.rate
  OR t.required_role_key IS NOT NULL AND t.required_role_key IS DISTINCT FROM role_key
  OR(a.scope_type='organization' AND a.scope_id IS NULL OR a.scope_type='property' AND a.scope_id=p.id OR a.scope_type='city' AND a.scope_id=p.city_id OR a.scope_type='region' AND a.scope_id=p.region_id OR a.scope_type='job' AND a.scope_id=t.id) IS NOT TRUE
  OR rp.key<>'staff.compensation_hourly_runs' OR rp.value->>'earning_unit' IS DISTINCT FROM 'VALIDATED_COMPLETED_WORK_SOURCE' OR rp.value->>'rounding' IS DISTINCT FROM 'HALF_UP_AT_EARNING_TOTAL'
  OR COALESCE(rp.value->>'overlap_between_sources','') NOT IN('REJECT_PER_PERSON','ALLOW_PER_VALIDATED_SOURCE')
 THEN RAISE EXCEPTION 'hourly earnings require their actual approved latest work, original performer contract and explicit earning unit';END IF;
 PERFORM app_assert_employee_work_time_source(q,false);
 IF (SELECT count(*) FROM operation_task_event e WHERE e.organization_id=v.organization_id AND e.task_id=t.id AND e.kind='CHANGED' AND e.after->>'state'='COMPLETED' AND e.before->>'state' IS DISTINCT FROM 'COMPLETED')<>1
  OR ((q.policy_snapshot->>'require_distinct_validator')::boolean AND d.decided_by_person_id=q.performed_by_person_id)
  OR v.source_snapshot->>'schemaVersion' IS DISTINCT FROM '1' OR v.source_snapshot->>'kind' IS DISTINCT FROM 'ACTUAL_HOURLY_EARNINGS'
  OR v.source_snapshot->>'taskId' IS DISTINCT FROM t.id::text OR v.source_snapshot->>'personId' IS DISTINCT FROM v.person_id::text OR v.source_snapshot->>'assignmentId' IS DISTINCT FROM a.id::text
  OR v.source_snapshot->>'evidenceId' IS DISTINCT FROM q.id::text OR v.source_snapshot->>'decisionId' IS DISTINCT FROM d.id::text OR v.source_snapshot->>'completionEventId' IS DISTINCT FROM q.completion_event_id::text
  OR v.source_snapshot->'completionEvent'->'after' IS DISTINCT FROM q.source_snapshot
  OR v.source_snapshot->>'runPolicyRuleId' IS DISTINCT FROM rp.id::text OR v.source_snapshot->>'runPolicyVersion' IS DISTINCT FROM rp.version::text OR v.source_snapshot->'runPolicy' IS DISTINCT FROM rp.value
  OR v.source_snapshot->>'workPolicyRuleId' IS DISTINCT FROM wp.id::text OR v.source_snapshot->>'workPolicyVersion' IS DISTINCT FROM wp.version::text OR v.source_snapshot->'workPolicy' IS DISTINCT FROM wp.value
  OR v.source_snapshot->'amount' IS DISTINCT FROM jsonb_build_object('amount',v.amount::numeric(18,2)::text,'currency',v.currency)
  OR v.source_snapshot->'intervals' IS DISTINCT FROM(SELECT jsonb_agg(jsonb_build_object('id',i.id::text,'startsAt',to_char(i.starts_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'endsAt',to_char(i.ends_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) ORDER BY i.position) FROM employee_work_time_interval i WHERE i.organization_id=v.organization_id AND i.evidence_id=q.id)
 THEN RAISE EXCEPTION 'hourly earning snapshots require their exact original relational work and policy evidence';END IF;
END $function$;
CREATE OR REPLACE FUNCTION app_assert_employee_hourly_source(v employee_compensation_run_line) RETURNS void LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE h employee_compensation_run%ROWTYPE;
BEGIN
 SELECT * INTO h FROM employee_compensation_run WHERE organization_id=v.organization_id AND id=v.run_id;
 IF h.id IS NULL OR EXISTS(SELECT 1 FROM employee_compensation_run_cancellation WHERE organization_id=v.organization_id AND run_id=h.id) THEN RAISE EXCEPTION 'hourly earnings require their actual approved latest work, original performer contract and explicit earning unit';END IF;
 PERFORM app_assert_employee_hourly_origin(v,h);
END $$;
CREATE OR REPLACE FUNCTION public.app_assert_employee_hourly_witnesses_for(p_owner_kind text, org_uuid uuid, line_uuid uuid)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE h employee_compensation_run%ROWTYPE;l employee_compensation_run_line%ROWTYPE;born xid;n integer;weighted numeric;expected numeric;milliseconds numeric;witness_row record;slot jsonb;a role_assignment%ROWTYPE;subject person%ROWTYPE;selected uuid;selected_rule uuid;
BEGIN
 IF p_owner_kind='RUN' THEN
 SELECT * INTO l FROM employee_compensation_run_line WHERE organization_id=org_uuid AND id=line_uuid;
 IF l.id IS NULL OR l.earning_kind IS DISTINCT FROM 'PER_HOUR' THEN RAISE EXCEPTION 'hourly witnesses require an actual hourly earning line';END IF;
 PERFORM app_assert_employee_hourly_source(l);
 SELECT xmin INTO born FROM employee_compensation_run_line WHERE organization_id=org_uuid AND id=line_uuid;
 ELSIF p_owner_kind='REQUEST' THEN
 SELECT(jsonb_populate_record(NULL::employee_compensation_run_line,to_jsonb(s)||jsonb_build_object('run_id',s.request_id,'earning_kind','PER_HOUR','task_id',e.task_id,'property_id',e.property_id,'completion_event_id',e.completion_event_id,'work_time_evidence_id',s.evidence_id,'work_time_decision_id',s.decision_id))).* INTO l
 FROM employee_earning_request_work s JOIN employee_work_time_evidence e ON e.organization_id=s.organization_id AND e.id=s.evidence_id WHERE s.organization_id=org_uuid AND s.id=line_uuid;
 IF l.id IS NULL THEN RAISE EXCEPTION 'hourly admission requires its actual retained work source';END IF;
 SELECT(jsonb_populate_record(NULL::employee_compensation_run,to_jsonb(r)||jsonb_build_object('created_by',r.requested_by,'created_at',r.requested_at))).* INTO h FROM employee_earning_run_request r WHERE r.organization_id=org_uuid AND r.id=l.run_id;
 PERFORM app_assert_employee_hourly_origin(l,h);
 SELECT xmin INTO born FROM employee_earning_request_work WHERE organization_id=org_uuid AND id=line_uuid;
 ELSE RAISE EXCEPTION 'unsupported hourly witness owner';END IF;
 SELECT * INTO a FROM role_assignment WHERE organization_id=org_uuid AND id=l.assignment_id;
 SELECT * INTO subject FROM person WHERE organization_id=org_uuid AND id=l.person_id;
 SELECT count(*),sum(c.amount*100*extract(epoch FROM(w.ends_at-w.starts_at))*1000) INTO n,weighted FROM employee_hourly_contract_witness w JOIN team_compensation c ON c.organization_id=w.organization_id AND c.id=w.compensation_id WHERE w.organization_id=org_uuid AND w.owner_kind=p_owner_kind AND w.owner_id=line_uuid;
 IF n=0 OR jsonb_array_length(l.source_snapshot->'witnesses') IS DISTINCT FROM n
  OR (SELECT min(position) FROM employee_hourly_contract_witness WHERE organization_id=org_uuid AND owner_kind=p_owner_kind AND owner_id=line_uuid)<>0
  OR (SELECT max(position) FROM employee_hourly_contract_witness WHERE organization_id=org_uuid AND owner_kind=p_owner_kind AND owner_id=line_uuid)<>n-1
  OR EXISTS(SELECT 1 FROM employee_hourly_contract_witness w JOIN employee_work_time_interval i ON i.organization_id=w.organization_id AND i.id=w.interval_id WHERE w.organization_id=org_uuid AND w.owner_kind=p_owner_kind AND w.owner_id=line_uuid AND(i.evidence_id<>l.work_time_evidence_id OR w.row_birth<>born OR w.starts_at<i.starts_at OR w.ends_at>i.ends_at))
  OR EXISTS(SELECT 1 FROM employee_work_time_interval i WHERE i.organization_id=org_uuid AND i.evidence_id=l.work_time_evidence_id AND(
   i.starts_at IS DISTINCT FROM(SELECT min(w.starts_at) FROM employee_hourly_contract_witness w WHERE w.organization_id=org_uuid AND w.owner_kind=p_owner_kind AND w.owner_id=line_uuid AND w.interval_id=i.id)
   OR i.ends_at IS DISTINCT FROM(SELECT max(w.ends_at) FROM employee_hourly_contract_witness w WHERE w.organization_id=org_uuid AND w.owner_kind=p_owner_kind AND w.owner_id=line_uuid AND w.interval_id=i.id)
   OR extract(epoch FROM(i.ends_at-i.starts_at)) IS DISTINCT FROM(SELECT sum(extract(epoch FROM(w.ends_at-w.starts_at))) FROM employee_hourly_contract_witness w WHERE w.organization_id=org_uuid AND w.owner_kind=p_owner_kind AND w.owner_id=line_uuid AND w.interval_id=i.id)))
  OR EXISTS(SELECT 1 FROM employee_hourly_contract_witness x JOIN employee_hourly_contract_witness y ON y.organization_id=x.organization_id AND y.owner_id=x.owner_id AND y.owner_kind=x.owner_kind AND y.interval_id=x.interval_id AND y.id>x.id WHERE x.organization_id=org_uuid AND x.owner_kind=p_owner_kind AND x.owner_id=line_uuid AND x.starts_at<y.ends_at AND y.starts_at<x.ends_at)
 THEN RAISE EXCEPTION 'hourly earnings require complete original interval coverage and same-birth immutable witnesses';END IF;
 expected=(trunc(weighted/3600000)+CASE WHEN mod(weighted,3600000)*2>=3600000 THEN 1 ELSE 0 END)/100;
 SELECT sum(extract(epoch FROM(ends_at-starts_at))*1000) INTO milliseconds FROM employee_work_time_interval WHERE organization_id=org_uuid AND evidence_id=l.work_time_evidence_id;
 IF l.amount IS DISTINCT FROM expected OR l.source_snapshot->>'milliseconds' IS DISTINCT FROM milliseconds::numeric(128,0)::text THEN RAISE EXCEPTION 'hourly Money must round exact integer-weighted original rates once at the earning total';END IF;
 FOR witness_row IN SELECT x.*,c.assignment_id,c.config_rule_id original_rule,c.mode,c.amount,c.currency,c.version contract_version,c.effective_from,r.version rule_version,r.scope_type,r.scope_id,r.value,r.effective_from rule_from FROM employee_hourly_contract_witness x
  JOIN team_compensation c ON c.organization_id=x.organization_id AND c.id=x.compensation_id JOIN config_rule r ON r.organization_id=x.organization_id AND r.id=x.config_rule_id
  WHERE x.organization_id=org_uuid AND x.owner_kind=p_owner_kind AND x.owner_id=line_uuid ORDER BY x.position LOOP
  SELECT id INTO selected FROM team_compensation WHERE organization_id=org_uuid AND assignment_id=a.id AND effective_from<=witness_row.starts_at ORDER BY version DESC LIMIT 1;
  SELECT id INTO selected_rule FROM config_rule WHERE organization_id=org_uuid AND key='staff.compensation' AND scope_type='role_assignment' AND scope_id=a.id AND archived_at IS NULL AND lifecycle IN('ACTIVE','RETIRED') AND effective_from<=witness_row.starts_at AND(effective_to IS NULL OR effective_to>witness_row.starts_at) ORDER BY effective_from DESC,version DESC LIMIT 1;
  slot=l.source_snapshot->'witnesses'->witness_row.position;
  IF witness_row.assignment_id<>a.id OR witness_row.original_rule<>witness_row.config_rule_id OR witness_row.mode<>'PER_HOUR' OR witness_row.currency<>l.currency OR witness_row.amount<0 OR witness_row.amount='NaN'::numeric
   OR witness_row.compensation_id IS DISTINCT FROM selected OR witness_row.config_rule_id IS DISTINCT FROM selected_rule OR witness_row.effective_from IS DISTINCT FROM witness_row.rule_from
   OR witness_row.scope_type<>'role_assignment' OR witness_row.scope_id IS DISTINCT FROM a.id OR witness_row.value->>'mode'<>'PER_HOUR' OR witness_row.value->>'currency' IS DISTINCT FROM l.currency::text OR (witness_row.value->>'amount')::numeric IS DISTINCT FROM witness_row.amount
   OR a.valid_from>witness_row.starts_at OR a.valid_to<witness_row.ends_at OR a.archived_at<witness_row.ends_at OR subject.archived_at<witness_row.ends_at
   OR EXISTS(SELECT 1 FROM team_compensation c WHERE c.organization_id=org_uuid AND c.assignment_id=a.id AND c.effective_from>witness_row.starts_at AND c.effective_from<witness_row.ends_at)
   OR EXISTS(SELECT 1 FROM config_rule r WHERE r.organization_id=org_uuid AND r.key='staff.compensation' AND r.scope_type='role_assignment' AND r.scope_id=a.id AND r.archived_at IS NULL AND r.lifecycle IN('ACTIVE','RETIRED') AND(r.effective_from>witness_row.starts_at AND r.effective_from<witness_row.ends_at OR r.effective_to>witness_row.starts_at AND r.effective_to<witness_row.ends_at))
   OR slot->>'intervalId' IS DISTINCT FROM witness_row.interval_id::text OR slot->>'compensationId' IS DISTINCT FROM witness_row.compensation_id::text OR slot->>'configRuleId' IS DISTINCT FROM witness_row.config_rule_id::text
   OR slot->>'compensationVersion' IS DISTINCT FROM witness_row.contract_version::text OR slot->>'configVersion' IS DISTINCT FROM witness_row.rule_version::text
   OR slot->>'startsAt' IS DISTINCT FROM to_char(witness_row.starts_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') OR slot->>'endsAt' IS DISTINCT FROM to_char(witness_row.ends_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
   OR slot->'rate' IS DISTINCT FROM jsonb_build_object('amount',witness_row.amount::numeric(18,2)::text,'currency',witness_row.currency)
   OR slot#>>'{assignment,id}' IS DISTINCT FROM a.id::text OR slot#>>'{assignment,personId}' IS DISTINCT FROM a.person_id::text OR slot#>>'{assignment,roleId}' IS DISTINCT FROM a.role_id::text
   OR slot#>>'{assignment,scopeType}' IS DISTINCT FROM a.scope_type OR slot#>>'{assignment,scopeId}' IS DISTINCT FROM a.scope_id::text
   OR slot#>>'{contractRule,id}' IS DISTINCT FROM witness_row.config_rule_id::text OR slot#>>'{contractRule,version}' IS DISTINCT FROM witness_row.rule_version::text OR slot#>'{contractRule,value}' IS DISTINCT FROM witness_row.value
   OR(witness_row.position=0 AND(witness_row.compensation_id<>l.compensation_id OR witness_row.config_rule_id<>l.config_rule_id OR witness_row.amount<>l.rate))
  THEN RAISE EXCEPTION 'hourly witnesses require every actual effective contract and original scoped configuration';END IF;
 END LOOP;
END $function$;
CREATE OR REPLACE FUNCTION app_assert_employee_hourly_witnesses(org_uuid uuid,line_uuid uuid) RETURNS void LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN PERFORM app_assert_employee_hourly_witnesses_for('RUN',org_uuid,line_uuid);END $$;

ALTER TABLE employee_earning_run_request ADD CONSTRAINT employee_earning_request_shape CHECK((
 earning_kind='PER_HOUR' AND request_fingerprint~'^[a-f0-9]{64}$' AND reviewed_source_fingerprint~'^[a-f0-9]{64}$'
 AND isfinite(from_on) AND isfinite(to_on) AND from_on<=to_on AND amount>=0 AND amount<>'NaN'::numeric AND currency~'^[A-Z]{3}$'
 AND jsonb_typeof(input)='object' AND jsonb_typeof(policy_snapshot)='object' AND jsonb_typeof(authorization_cap)='object'
 AND authorization_cap->>'schemaVersion'='1' AND authorization_cap->>'organizationId'=organization_id::text AND authorization_cap->>'userAccountId'=requested_by::text
 AND input->>'idempotencyKey'=idempotency_key::text AND input->>'fromOn'=from_on::text AND input->>'toOn'=to_on::text AND input->>'currency'=currency
 AND length(btrim(input->>'purpose')) BETWEEN 3 AND 1000 AND length(btrim(input->>'reason')) BETWEEN 6 AND 500
 AND jsonb_typeof(input->'jobs')='array' AND jsonb_array_length(input->'jobs') BETWEEN 1 AND 10000
 AND(input-'fromOn'-'toOn'-'currency'-'purpose'-'reason'-'idempotencyKey'-'jobs')='{}'::jsonb
) IS TRUE);
ALTER TABLE employee_earning_request_work ADD CONSTRAINT employee_earning_work_shape CHECK(rate>=0 AND amount>=0 AND rate<>'NaN'::numeric AND amount<>'NaN'::numeric AND currency~'^[A-Z]{3}$' AND isfinite(recorded_completion_at) AND jsonb_typeof(source_snapshot)='object');
ALTER TABLE employee_earning_request_hourly_witness ADD CONSTRAINT employee_earning_witness_shape CHECK(position>=0 AND starts_at<ends_at AND isfinite(starts_at) AND isfinite(ends_at));
ALTER TABLE employee_earning_run_outcome ADD CONSTRAINT employee_earning_outcome_shape CHECK((
 state='SUCCEEDED' AND run_id IS NOT NULL AND failure_code IS NULL OR state='DENIED' AND run_id IS NULL AND failure_code='ACCESS_DENIED'
 OR state='CONFLICT' AND run_id IS NULL AND failure_code IN('SOURCE_CHANGED','POLICY_UNAVAILABLE') OR state='FAILED' AND run_id IS NULL AND failure_code='EXECUTION_UNAVAILABLE'
) IS TRUE);

ALTER TABLE employee_earning_run_request ENABLE ROW LEVEL SECURITY;
ALTER TABLE employee_earning_run_request FORCE ROW LEVEL SECURITY;
CREATE POLICY employee_earning_run_request_tenant_isolation ON employee_earning_run_request USING(organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid) WITH CHECK(organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid);
ALTER TABLE employee_earning_request_work ENABLE ROW LEVEL SECURITY;
ALTER TABLE employee_earning_request_work FORCE ROW LEVEL SECURITY;
CREATE POLICY employee_earning_request_work_tenant_isolation ON employee_earning_request_work USING(organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid) WITH CHECK(organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid);
ALTER TABLE employee_earning_request_hourly_witness ENABLE ROW LEVEL SECURITY;
ALTER TABLE employee_earning_request_hourly_witness FORCE ROW LEVEL SECURITY;
CREATE POLICY employee_earning_request_hourly_witness_tenant_isolation ON employee_earning_request_hourly_witness USING(organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid) WITH CHECK(organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid);
ALTER TABLE employee_earning_run_outcome ENABLE ROW LEVEL SECURITY;
ALTER TABLE employee_earning_run_outcome FORCE ROW LEVEL SECURITY;
CREATE POLICY employee_earning_run_outcome_tenant_isolation ON employee_earning_run_outcome USING(organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid) WITH CHECK(organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid);

CREATE FUNCTION app_employee_earning_request_admission() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE h employee_compensation_run%ROWTYPE;
BEGIN
 NEW.requested_at=clock_timestamp();
 IF NOT EXISTS(SELECT 1 FROM user_account a JOIN person p ON p.organization_id=a.organization_id AND p.id=a.person_id WHERE a.organization_id=NEW.organization_id AND a.id=NEW.requested_by AND a.status='ACTIVE' AND p.archived_at IS NULL)
  OR NOT EXISTS(SELECT 1 FROM currency WHERE code=NEW.currency AND minor_unit<=2)
  OR EXISTS(SELECT 1 FROM employee_compensation_run WHERE organization_id=NEW.organization_id AND idempotency_key=NEW.idempotency_key)
 THEN RAISE EXCEPTION 'earning admission requires its active actual actor, supported currency and unused run intent';END IF;
 h=jsonb_populate_record(NULL::employee_compensation_run,to_jsonb(NEW)||jsonb_build_object('created_at',NEW.requested_at,'created_by',NEW.requested_by,'purpose',NEW.input->>'purpose','reason',NEW.input->>'reason'));
 PERFORM app_assert_employee_hourly_header(h);RETURN NEW;
END $$;
CREATE TRIGGER employee_earning_request_admission BEFORE INSERT ON employee_earning_run_request FOR EACH ROW EXECUTE FUNCTION app_employee_earning_request_admission();

CREATE FUNCTION app_employee_earning_source_birth() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.created_at=clock_timestamp();RETURN NEW;END $$;
CREATE TRIGGER employee_earning_work_birth BEFORE INSERT ON employee_earning_request_work FOR EACH ROW EXECUTE FUNCTION app_employee_earning_source_birth();
CREATE TRIGGER employee_earning_witness_birth BEFORE INSERT ON employee_earning_request_hourly_witness FOR EACH ROW EXECUTE FUNCTION app_employee_earning_source_birth();
CREATE FUNCTION app_employee_earning_outcome_birth() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.occurred_at=clock_timestamp();RETURN NEW;END $$;
CREATE TRIGGER employee_earning_outcome_birth BEFORE INSERT ON employee_earning_run_outcome FOR EACH ROW EXECUTE FUNCTION app_employee_earning_outcome_birth();

CREATE FUNCTION app_assert_employee_earning_request(org_uuid uuid,request_uuid uuid) RETURNS void LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE q employee_earning_run_request%ROWTYPE;h employee_compensation_run%ROWTYPE;born xid;n integer;total numeric;line employee_earning_request_work%ROWTYPE;
BEGIN
 SELECT * INTO q FROM employee_earning_run_request WHERE organization_id=org_uuid AND id=request_uuid;
 SELECT xmin INTO born FROM employee_earning_run_request WHERE organization_id=org_uuid AND id=request_uuid;
 IF q.id IS NULL THEN RAISE EXCEPTION 'actual earning request required';END IF;
 h=jsonb_populate_record(NULL::employee_compensation_run,to_jsonb(q)||jsonb_build_object('created_at',q.requested_at,'created_by',q.requested_by,'purpose',q.input->>'purpose','reason',q.input->>'reason'));
 PERFORM app_assert_employee_hourly_header(h);
 SELECT count(*),sum(amount) INTO n,total FROM employee_earning_request_work WHERE organization_id=org_uuid AND request_id=request_uuid;
 IF n=0 OR n IS DISTINCT FROM jsonb_array_length(q.input->'jobs') OR q.amount IS DISTINCT FROM total
  OR EXISTS(SELECT 1 FROM employee_earning_request_work s WHERE s.organization_id=org_uuid AND s.request_id=request_uuid AND(s.xmin<>born OR s.created_at<q.requested_at OR s.currency<>q.currency))
  OR EXISTS(SELECT 1 FROM employee_earning_request_work s JOIN employee_work_time_evidence e ON e.organization_id=s.organization_id AND e.id=s.evidence_id WHERE s.organization_id=org_uuid AND s.request_id=request_uuid AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(q.input->'jobs') job WHERE job->>'taskId'=e.task_id::text AND job->>'assignmentId'=s.assignment_id::text AND job->>'evidenceId'=s.evidence_id::text AND job->>'decisionId'=s.decision_id::text AND job->'confirmedAssignment'='true'::jsonb AND(job-'taskId'-'assignmentId'-'evidenceId'-'decisionId'-'confirmedAssignment')='{}'::jsonb))
  OR(SELECT count(DISTINCT e.task_id) FROM employee_earning_request_work s JOIN employee_work_time_evidence e ON e.organization_id=s.organization_id AND e.id=s.evidence_id WHERE s.organization_id=org_uuid AND s.request_id=request_uuid)<>n
 THEN RAISE EXCEPTION 'earning admission requires its complete distinct actual sources, reviewed Money and same-birth witnesses';END IF;
 FOR line IN SELECT * FROM employee_earning_request_work WHERE organization_id=org_uuid AND request_id=request_uuid ORDER BY id LOOP
  PERFORM app_assert_employee_hourly_witnesses_for('REQUEST',org_uuid,line.id);
 END LOOP;
 IF q.policy_snapshot#>>'{value,overlap_between_sources}'='REJECT_PER_PERSON' AND EXISTS(
  SELECT 1 FROM employee_earning_request_work a JOIN employee_earning_request_work b ON b.organization_id=a.organization_id AND b.request_id=a.request_id AND b.person_id=a.person_id AND b.id>a.id
  JOIN employee_work_time_interval x ON x.organization_id=a.organization_id AND x.evidence_id=a.evidence_id JOIN employee_work_time_interval y ON y.organization_id=b.organization_id AND y.evidence_id=b.evidence_id
  WHERE a.organization_id=org_uuid AND a.request_id=request_uuid AND x.starts_at<y.ends_at AND y.starts_at<x.ends_at
 ) THEN RAISE EXCEPTION 'earning admission policy rejects overlapping actual work sources for one person';END IF;
 IF(SELECT count(*) FROM audit_log a WHERE a.organization_id=org_uuid AND a.resource_type='employee_earning_run_request' AND a.resource_id=q.id AND a.action='finance.employee_compensation.earning_run_requested')<>1
  OR NOT EXISTS(SELECT 1 FROM audit_log a WHERE a.organization_id=org_uuid AND a.resource_type='employee_earning_run_request' AND a.resource_id=q.id AND a.action='finance.employee_compensation.earning_run_requested' AND a.actor_id=q.requested_by AND a.reason=q.input->>'reason' AND a.after=jsonb_build_object('requestId',q.id::text) AND a.xmin=born)
  OR NOT EXISTS(SELECT 1 FROM outbox_event e WHERE e.organization_id=org_uuid AND e.type='EmployeeEarningRunRequested' AND e.idempotency_key='employee-earning-run-request:'||q.id::text||':requested' AND e.payload=jsonb_build_object('requestId',q.id::text) AND e.occurred_at=date_trunc('milliseconds',q.requested_at) AND e.xmin=born)
  OR NOT EXISTS(SELECT 1 FROM outbox_event e WHERE e.organization_id=org_uuid AND e.type='alvillas/outbox.dispatch.requested' AND e.idempotency_key='employee-earning-run:'||q.id::text||':dispatch' AND e.payload='{}'::jsonb AND e.xmin=born)
 THEN RAISE EXCEPTION 'earning admission requires its unique attributed atomic audit, original event and durable dispatch';END IF;
END $$;

CREATE FUNCTION app_employee_earning_request_complete() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE request_uuid uuid;
BEGIN
 IF TG_TABLE_NAME='employee_earning_run_request' THEN request_uuid=NEW.id;
 ELSIF TG_TABLE_NAME='employee_earning_request_work' THEN request_uuid=NEW.request_id;
 ELSE SELECT request_id INTO request_uuid FROM employee_earning_request_work WHERE organization_id=NEW.organization_id AND id=NEW.source_id;END IF;
 PERFORM app_assert_employee_earning_request(NEW.organization_id,request_uuid);RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER employee_earning_request_complete AFTER INSERT ON employee_earning_run_request DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app_employee_earning_request_complete();
CREATE CONSTRAINT TRIGGER employee_earning_work_complete AFTER INSERT ON employee_earning_request_work DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app_employee_earning_request_complete();
CREATE CONSTRAINT TRIGGER employee_earning_witness_complete AFTER INSERT ON employee_earning_request_hourly_witness DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app_employee_earning_request_complete();

CREATE FUNCTION app_employee_earning_outcome_complete() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE q employee_earning_run_request%ROWTYPE;r employee_compensation_run%ROWTYPE;born xid;run_born xid;total numeric;
BEGIN
 SELECT * INTO q FROM employee_earning_run_request WHERE organization_id=NEW.organization_id AND id=NEW.request_id;
 SELECT xmin INTO born FROM employee_earning_run_outcome WHERE organization_id=NEW.organization_id AND id=NEW.id;
 IF q.id IS NULL OR NEW.occurred_at<q.requested_at THEN RAISE EXCEPTION 'earning outcome requires its actual original request';END IF;
 IF NEW.state='SUCCEEDED' THEN
  SELECT * INTO r FROM employee_compensation_run WHERE organization_id=NEW.organization_id AND id=NEW.run_id;
  SELECT xmin INTO run_born FROM employee_compensation_run WHERE organization_id=NEW.organization_id AND id=NEW.run_id;
  SELECT sum(amount) INTO total FROM employee_compensation_run_line WHERE organization_id=NEW.organization_id AND run_id=NEW.run_id;
  IF r.id IS NULL OR run_born IS DISTINCT FROM born OR r.created_at<q.requested_at OR r.earning_kind<>q.earning_kind OR r.created_by<>q.requested_by OR r.idempotency_key<>q.idempotency_key OR r.request_fingerprint<>q.request_fingerprint
   OR r.from_on<>q.from_on OR r.to_on<>q.to_on OR r.timezone<>q.timezone OR r.currency<>q.currency OR r.policy_rule_id<>q.policy_rule_id OR r.policy_snapshot IS DISTINCT FROM q.policy_snapshot OR total IS DISTINCT FROM q.amount OR r.reason IS DISTINCT FROM q.input->>'reason' OR r.purpose IS DISTINCT FROM q.input->>'purpose'
   OR(SELECT count(*) FROM employee_compensation_run_line WHERE organization_id=NEW.organization_id AND run_id=r.id)<>(SELECT count(*) FROM employee_earning_request_work WHERE organization_id=NEW.organization_id AND request_id=q.id)
   OR EXISTS(SELECT 1 FROM employee_earning_request_work s WHERE s.organization_id=NEW.organization_id AND s.request_id=q.id AND NOT EXISTS(SELECT 1 FROM employee_compensation_run_line l WHERE l.organization_id=s.organization_id AND l.run_id=r.id AND l.person_id=s.person_id AND l.assignment_id=s.assignment_id AND l.compensation_id=s.compensation_id AND l.config_rule_id=s.config_rule_id AND l.work_time_evidence_id=s.evidence_id AND l.work_time_decision_id=s.decision_id AND l.recorded_completion_at=s.recorded_completion_at AND l.rate=s.rate AND l.amount=s.amount AND l.currency=s.currency AND l.source_snapshot=s.source_snapshot))
  THEN RAISE EXCEPTION 'successful earning outcome must bind the exact original reviewed same-birth financial run';END IF;
 ELSIF EXISTS(SELECT 1 FROM employee_compensation_run created_run WHERE created_run.organization_id=NEW.organization_id AND created_run.idempotency_key=q.idempotency_key AND created_run.xmin=born) THEN
  RAISE EXCEPTION 'failed earning outcomes cannot create an associated financial run';
 END IF;
 IF(SELECT count(*) FROM audit_log a WHERE a.organization_id=NEW.organization_id AND a.resource_type='employee_earning_run_request' AND a.resource_id=q.id AND a.action='finance.employee_compensation.earning_run_completed')<>1
  OR NOT EXISTS(SELECT 1 FROM audit_log a WHERE a.organization_id=NEW.organization_id AND a.resource_type='employee_earning_run_request' AND a.resource_id=q.id AND a.action='finance.employee_compensation.earning_run_completed' AND a.actor_id=q.requested_by AND a.reason=q.input->>'reason' AND a.xmin=born AND a.after=jsonb_build_object('requestId',q.id::text,'outcomeId',NEW.id::text,'state',NEW.state,'runId',NEW.run_id::text,'failureCode',NEW.failure_code))
 THEN RAISE EXCEPTION 'earning outcome requires its unique attributed atomic completion audit';END IF;RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER employee_earning_outcome_complete AFTER INSERT ON employee_earning_run_outcome DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app_employee_earning_outcome_complete();

CREATE TRIGGER employee_earning_request_immutable BEFORE UPDATE OR DELETE ON employee_earning_run_request FOR EACH ROW EXECUTE FUNCTION app_operation_immutable();
CREATE TRIGGER employee_earning_work_immutable BEFORE UPDATE OR DELETE ON employee_earning_request_work FOR EACH ROW EXECUTE FUNCTION app_operation_immutable();
CREATE TRIGGER employee_earning_witness_immutable BEFORE UPDATE OR DELETE ON employee_earning_request_hourly_witness FOR EACH ROW EXECUTE FUNCTION app_operation_immutable();
CREATE TRIGGER employee_earning_outcome_immutable BEFORE UPDATE OR DELETE ON employee_earning_run_outcome FOR EACH ROW EXECUTE FUNCTION app_operation_immutable();

CREATE OR REPLACE FUNCTION app_guard_employee_hourly_assignment_identity() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
 IF ROW(NEW.id,NEW.organization_id,NEW.person_id,NEW.role_id,NEW.scope_type,NEW.scope_id,NEW.valid_from) IS DISTINCT FROM ROW(OLD.id,OLD.organization_id,OLD.person_id,OLD.role_id,OLD.scope_type,OLD.scope_id,OLD.valid_from)
  AND(EXISTS(SELECT 1 FROM employee_compensation_hourly_witness w JOIN team_compensation c ON c.organization_id=w.organization_id AND c.id=w.compensation_id WHERE c.organization_id=OLD.organization_id AND c.assignment_id=OLD.id)
   OR EXISTS(SELECT 1 FROM employee_earning_request_hourly_witness w JOIN team_compensation c ON c.organization_id=w.organization_id AND c.id=w.compensation_id WHERE c.organization_id=OLD.organization_id AND c.assignment_id=OLD.id))
 THEN RAISE EXCEPTION 'Original hourly earning assignment identity is immutable; retire it and append a replacement' USING ERRCODE='23514';END IF;RETURN NEW;
END $$;

COMMIT;
