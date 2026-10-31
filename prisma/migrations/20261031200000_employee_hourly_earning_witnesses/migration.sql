-- AlterTable
ALTER TABLE "employee_compensation_run_line" ADD COLUMN     "work_time_decision_id" UUID,
ADD COLUMN     "work_time_evidence_id" UUID;

-- CreateTable
CREATE TABLE "employee_compensation_hourly_witness" (
    "id" UUID NOT NULL DEFAULT app_uuid_v7(),
    "organization_id" UUID NOT NULL,
    "run_line_id" UUID NOT NULL,
    "interval_id" UUID NOT NULL,
    "compensation_id" UUID NOT NULL,
    "config_rule_id" UUID NOT NULL,
    "position" INTEGER NOT NULL,
    "starts_at" TIMESTAMPTZ(3) NOT NULL,
    "ends_at" TIMESTAMPTZ(3) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "employee_compensation_hourly_witness_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "employee_hourly_witness_interval_idx" ON "employee_compensation_hourly_witness"("organization_id", "interval_id");

-- CreateIndex
CREATE UNIQUE INDEX "employee_hourly_witness_org_id_unique" ON "employee_compensation_hourly_witness"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "employee_hourly_witness_position_unique" ON "employee_compensation_hourly_witness"("organization_id", "run_line_id", "position");

-- CreateIndex
CREATE UNIQUE INDEX "employee_hourly_witness_interval_start_unique" ON "employee_compensation_hourly_witness"("organization_id", "run_line_id", "interval_id", "starts_at");

-- CreateIndex
CREATE INDEX "employee_work_time_latest_task_idx" ON "employee_work_time_evidence"("organization_id", "task_id", "version" DESC);

-- AddForeignKey
ALTER TABLE "employee_compensation_run_line" ADD CONSTRAINT "employee_hourly_line_evidence_fk" FOREIGN KEY ("organization_id", "work_time_evidence_id") REFERENCES "employee_work_time_evidence"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "employee_compensation_run_line" ADD CONSTRAINT "employee_hourly_line_decision_fk" FOREIGN KEY ("organization_id", "work_time_decision_id") REFERENCES "employee_work_time_decision"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "employee_compensation_hourly_witness" ADD CONSTRAINT "employee_compensation_hourly_witness_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "employee_compensation_hourly_witness" ADD CONSTRAINT "employee_hourly_witness_line_fk" FOREIGN KEY ("organization_id", "run_line_id") REFERENCES "employee_compensation_run_line"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "employee_compensation_hourly_witness" ADD CONSTRAINT "employee_hourly_witness_interval_fk" FOREIGN KEY ("organization_id", "interval_id") REFERENCES "employee_work_time_interval"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "employee_compensation_hourly_witness" ADD CONSTRAINT "employee_hourly_witness_contract_fk" FOREIGN KEY ("organization_id", "compensation_id") REFERENCES "team_compensation"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "employee_compensation_hourly_witness" ADD CONSTRAINT "employee_hourly_witness_rule_fk" FOREIGN KEY ("organization_id", "config_rule_id") REFERENCES "config_rule"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE employee_compensation_hourly_witness ADD CONSTRAINT employee_hourly_witness_shape CHECK(position>=0 AND starts_at<ends_at AND isfinite(starts_at) AND isfinite(ends_at));

CREATE FUNCTION app_assert_employee_hourly_source(v employee_compensation_run_line) RETURNS void LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE h employee_compensation_run%ROWTYPE;q employee_work_time_evidence%ROWTYPE;d employee_work_time_decision%ROWTYPE;a role_assignment%ROWTYPE;c team_compensation%ROWTYPE;r config_rule%ROWTYPE;wp config_rule%ROWTYPE;rp config_rule%ROWTYPE;t operation_task%ROWTYPE;p property%ROWTYPE;role_key text;
BEGIN
 SELECT * INTO h FROM employee_compensation_run WHERE organization_id=v.organization_id AND id=v.run_id;
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
  OR EXISTS(SELECT 1 FROM employee_compensation_run_cancellation WHERE organization_id=v.organization_id AND run_id=h.id)
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
END $$;

CREATE FUNCTION app_assert_employee_hourly_witnesses(org_uuid uuid,line_uuid uuid) RETURNS void LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE l employee_compensation_run_line%ROWTYPE;born xid;n integer;weighted numeric;expected numeric;milliseconds numeric;witness_row record;slot jsonb;a role_assignment%ROWTYPE;subject person%ROWTYPE;selected uuid;selected_rule uuid;
BEGIN
 SELECT * INTO l FROM employee_compensation_run_line WHERE organization_id=org_uuid AND id=line_uuid;
 IF l.id IS NULL OR l.earning_kind IS DISTINCT FROM 'PER_HOUR' THEN RAISE EXCEPTION 'hourly witnesses require an actual hourly earning line';END IF;
 PERFORM app_assert_employee_hourly_source(l);
 SELECT xmin INTO born FROM employee_compensation_run_line WHERE organization_id=org_uuid AND id=line_uuid;
 SELECT * INTO a FROM role_assignment WHERE organization_id=org_uuid AND id=l.assignment_id;
 SELECT * INTO subject FROM person WHERE organization_id=org_uuid AND id=l.person_id;
 SELECT count(*),sum(c.amount*100*extract(epoch FROM(w.ends_at-w.starts_at))*1000) INTO n,weighted FROM employee_compensation_hourly_witness w JOIN team_compensation c ON c.organization_id=w.organization_id AND c.id=w.compensation_id WHERE w.organization_id=org_uuid AND w.run_line_id=line_uuid;
 IF n=0 OR jsonb_array_length(l.source_snapshot->'witnesses') IS DISTINCT FROM n
  OR (SELECT min(position) FROM employee_compensation_hourly_witness WHERE organization_id=org_uuid AND run_line_id=line_uuid)<>0
  OR (SELECT max(position) FROM employee_compensation_hourly_witness WHERE organization_id=org_uuid AND run_line_id=line_uuid)<>n-1
  OR EXISTS(SELECT 1 FROM employee_compensation_hourly_witness w JOIN employee_work_time_interval i ON i.organization_id=w.organization_id AND i.id=w.interval_id WHERE w.organization_id=org_uuid AND w.run_line_id=line_uuid AND(i.evidence_id<>l.work_time_evidence_id OR w.xmin<>born OR w.starts_at<i.starts_at OR w.ends_at>i.ends_at))
  OR EXISTS(SELECT 1 FROM employee_work_time_interval i WHERE i.organization_id=org_uuid AND i.evidence_id=l.work_time_evidence_id AND(
   i.starts_at IS DISTINCT FROM(SELECT min(w.starts_at) FROM employee_compensation_hourly_witness w WHERE w.organization_id=org_uuid AND w.run_line_id=line_uuid AND w.interval_id=i.id)
   OR i.ends_at IS DISTINCT FROM(SELECT max(w.ends_at) FROM employee_compensation_hourly_witness w WHERE w.organization_id=org_uuid AND w.run_line_id=line_uuid AND w.interval_id=i.id)
   OR extract(epoch FROM(i.ends_at-i.starts_at)) IS DISTINCT FROM(SELECT sum(extract(epoch FROM(w.ends_at-w.starts_at))) FROM employee_compensation_hourly_witness w WHERE w.organization_id=org_uuid AND w.run_line_id=line_uuid AND w.interval_id=i.id)))
  OR EXISTS(SELECT 1 FROM employee_compensation_hourly_witness x JOIN employee_compensation_hourly_witness y ON y.organization_id=x.organization_id AND y.run_line_id=x.run_line_id AND y.interval_id=x.interval_id AND y.id>x.id WHERE x.organization_id=org_uuid AND x.run_line_id=line_uuid AND x.starts_at<y.ends_at AND y.starts_at<x.ends_at)
 THEN RAISE EXCEPTION 'hourly earnings require complete original interval coverage and same-birth immutable witnesses';END IF;
 expected=(trunc(weighted/3600000)+CASE WHEN mod(weighted,3600000)*2>=3600000 THEN 1 ELSE 0 END)/100;
 SELECT sum(extract(epoch FROM(ends_at-starts_at))*1000) INTO milliseconds FROM employee_work_time_interval WHERE organization_id=org_uuid AND evidence_id=l.work_time_evidence_id;
 IF l.amount IS DISTINCT FROM expected OR l.source_snapshot->>'milliseconds' IS DISTINCT FROM milliseconds::numeric(128,0)::text THEN RAISE EXCEPTION 'hourly Money must round exact integer-weighted original rates once at the earning total';END IF;
 FOR witness_row IN SELECT x.*,c.assignment_id,c.config_rule_id original_rule,c.mode,c.amount,c.currency,c.version contract_version,c.effective_from,r.version rule_version,r.scope_type,r.scope_id,r.value,r.effective_from rule_from FROM employee_compensation_hourly_witness x
  JOIN team_compensation c ON c.organization_id=x.organization_id AND c.id=x.compensation_id JOIN config_rule r ON r.organization_id=x.organization_id AND r.id=x.config_rule_id
  WHERE x.organization_id=org_uuid AND x.run_line_id=line_uuid ORDER BY x.position LOOP
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
END $$;

CREATE FUNCTION app_employee_hourly_witness_complete() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN PERFORM app_assert_employee_hourly_witnesses(NEW.organization_id,NEW.run_line_id);RETURN NULL;END $$;
CREATE CONSTRAINT TRIGGER employee_hourly_witness_complete AFTER INSERT ON employee_compensation_hourly_witness DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app_employee_hourly_witness_complete();
CREATE TRIGGER employee_hourly_witness_immutable BEFORE UPDATE OR DELETE ON employee_compensation_hourly_witness FOR EACH ROW EXECUTE FUNCTION app_operation_immutable();
ALTER TABLE employee_compensation_hourly_witness ENABLE ROW LEVEL SECURITY;
ALTER TABLE employee_compensation_hourly_witness FORCE ROW LEVEL SECURITY;
CREATE POLICY employee_compensation_hourly_witness_tenant_isolation ON employee_compensation_hourly_witness USING(organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid) WITH CHECK(organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid);

CREATE FUNCTION app_assert_employee_hourly_header(h employee_compensation_run) RETURNS void LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE p config_rule%ROWTYPE;selected uuid;
BEGIN
 SELECT * INTO p FROM config_rule WHERE organization_id=h.organization_id AND id=h.policy_rule_id;
 SELECT id INTO selected FROM config_rule WHERE organization_id=h.organization_id AND key='staff.compensation_hourly_runs' AND scope_type='organization' AND scope_id IS NULL AND archived_at IS NULL AND lifecycle IN('ACTIVE','RETIRED') AND effective_from<=h.created_at AND(effective_to IS NULL OR effective_to>h.created_at) ORDER BY effective_from DESC,version DESC LIMIT 1;
 IF p.id IS NULL OR p.id IS DISTINCT FROM selected OR p.key<>'staff.compensation_hourly_runs' OR p.scope_type<>'organization' OR p.scope_id IS NOT NULL
  OR p.value->>'earning_date' IS DISTINCT FROM 'RECORDED_COMPLETION' OR p.value->>'earning_unit' IS DISTINCT FROM 'VALIDATED_COMPLETED_WORK_SOURCE' OR p.value->>'rounding' IS DISTINCT FROM 'HALF_UP_AT_EARNING_TOTAL'
  OR COALESCE(p.value->>'overlap_between_sources','') NOT IN('REJECT_PER_PERSON','ALLOW_PER_VALIDATED_SOURCE')
  OR p.value->>'timezone' IS DISTINCT FROM h.timezone OR NOT EXISTS(SELECT 1 FROM pg_timezone_names WHERE name=h.timezone)
  OR jsonb_typeof(p.value->'max_period_days') IS DISTINCT FROM 'number' OR (p.value->>'max_period_days')::numeric<=0 OR (p.value->>'max_period_days')::numeric>2147483647
  OR (p.value->>'max_period_days')::numeric<>trunc((p.value->>'max_period_days')::numeric) OR h.to_on-h.from_on+1>(p.value->>'max_period_days')::numeric
  OR (p.value-'earning_date'-'earning_unit'-'rounding'-'overlap_between_sources'-'timezone'-'max_period_days')<>'{}'::jsonb
  OR h.policy_snapshot IS DISTINCT FROM jsonb_build_object('schemaVersion',1,'policyRuleId',p.id::text,'policyVersion',p.version,'value',p.value)
 THEN RAISE EXCEPTION 'hourly run requires its actual canonical configured earning unit and recorded-completion calendar';END IF;
END $$;

CREATE FUNCTION app_assert_employee_hourly_run(h employee_compensation_run) RETURNS void LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE n integer;total numeric;l employee_compensation_run_line%ROWTYPE;born xid;
BEGIN
 SELECT xmin INTO born FROM employee_compensation_run WHERE organization_id=h.organization_id AND id=h.id;
 SELECT count(*),sum(amount) INTO n,total FROM employee_compensation_run_line WHERE organization_id=h.organization_id AND run_id=h.id;
 IF n=0 OR EXISTS(SELECT 1 FROM employee_compensation_run_line WHERE organization_id=h.organization_id AND run_id=h.id AND(earning_kind<>'PER_HOUR' OR xmin<>born))
  OR(SELECT count(*) FROM audit_log WHERE organization_id=h.organization_id AND resource_type='employee_compensation_run' AND resource_id=h.id AND action='finance.employee_compensation_run.created')<>1
  OR NOT EXISTS(SELECT 1 FROM audit_log a WHERE a.organization_id=h.organization_id AND a.resource_type='employee_compensation_run' AND a.resource_id=h.id AND a.action='finance.employee_compensation_run.created' AND a.xmin=born AND a.actor_id=h.created_by AND a.reason=h.reason
   AND a.after=jsonb_build_object('runId',h.id::text,'kind','HOURLY_WORK_DRAFT','lineCount',n,'total',jsonb_build_object('amount',total::numeric(128,2)::text,'currency',h.currency)))
  OR NOT EXISTS(SELECT 1 FROM outbox_event e WHERE e.organization_id=h.organization_id AND e.type='EmployeeCompensationRunCreated' AND e.xmin=born AND e.idempotency_key='employee-compensation-run:'||h.id::text||':created' AND e.payload=jsonb_build_object('runId',h.id::text))
 THEN RAISE EXCEPTION 'hourly run requires complete same-birth source lines and its attributed atomic receipt';END IF;
 FOR l IN SELECT * FROM employee_compensation_run_line WHERE organization_id=h.organization_id AND run_id=h.id LOOP PERFORM app_assert_employee_hourly_witnesses(l.organization_id,l.id);END LOOP;
 IF h.policy_snapshot#>>'{value,overlap_between_sources}'='REJECT_PER_PERSON' AND EXISTS(
  SELECT 1 FROM employee_compensation_run_line a JOIN employee_compensation_run_line b ON b.organization_id=a.organization_id AND b.run_id=a.run_id AND b.person_id=a.person_id AND b.id>a.id
  JOIN employee_work_time_interval x ON x.organization_id=a.organization_id AND x.evidence_id=a.work_time_evidence_id
  JOIN employee_work_time_interval y ON y.organization_id=b.organization_id AND y.evidence_id=b.work_time_evidence_id
  WHERE a.organization_id=h.organization_id AND a.run_id=h.id AND x.starts_at<y.ends_at AND y.starts_at<x.ends_at)
 THEN RAISE EXCEPTION 'hourly run policy rejects overlapping actual work sources for the same person';END IF;
END $$;

ALTER TABLE employee_compensation_run DROP CONSTRAINT employee_run_earning_kind;
ALTER TABLE employee_compensation_run ADD CONSTRAINT employee_run_earning_kind CHECK(earning_kind IN('PER_JOB','PER_MONTH','PER_HOUR'));
ALTER TABLE employee_compensation_run_line DROP CONSTRAINT employee_compensation_run_line_fields;
ALTER TABLE employee_compensation_run_line ADD CONSTRAINT employee_compensation_run_line_fields CHECK(rate>=0 AND amount>=0 AND rate<>'NaN'::numeric AND amount<>'NaN'::numeric AND(
 (earning_kind='PER_JOB' AND rate=amount AND task_id IS NOT NULL AND completion_event_id IS NOT NULL AND property_id IS NOT NULL AND earning_period_key IS NULL AND source_city_id IS NULL AND source_region_id IS NULL AND work_time_evidence_id IS NULL AND work_time_decision_id IS NULL)
 OR(earning_kind='PER_MONTH' AND completion_event_id IS NULL AND earning_period_key~'^\d{4}-(0[1-9]|1[0-2])$' AND work_time_evidence_id IS NULL AND work_time_decision_id IS NULL)
 OR(earning_kind='PER_HOUR' AND task_id IS NOT NULL AND completion_event_id IS NOT NULL AND property_id IS NOT NULL AND earning_period_key IS NULL AND source_city_id IS NULL AND source_region_id IS NULL AND work_time_evidence_id IS NOT NULL AND work_time_decision_id IS NOT NULL)));

CREATE OR REPLACE FUNCTION public.app_employee_compensation_run_admission()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE policy config_rule%ROWTYPE; point timestamptz;
BEGIN

 IF NEW.earning_kind='PER_HOUR' THEN NEW.created_at=clock_timestamp();PERFORM app_assert_employee_hourly_header(NEW);RETURN NEW;END IF;
 IF NEW.earning_kind='PER_MONTH' THEN
  point=clock_timestamp();SELECT * INTO policy FROM config_rule WHERE organization_id=NEW.organization_id AND id=NEW.policy_rule_id;
  IF policy.id IS NULL OR policy.key IS DISTINCT FROM 'staff.compensation_monthly_earnings' OR policy.scope_type IS DISTINCT FROM 'organization' OR policy.scope_id IS NOT NULL
   OR policy.archived_at IS NOT NULL OR policy.lifecycle NOT IN('ACTIVE','RETIRED') OR policy.effective_from>point OR policy.effective_to<=point
   OR policy.id IS DISTINCT FROM(SELECT p.id FROM config_rule p WHERE p.organization_id=NEW.organization_id AND p.key='staff.compensation_monthly_earnings' AND p.scope_type='organization' AND p.scope_id IS NULL
    AND p.archived_at IS NULL AND p.lifecycle IN('ACTIVE','RETIRED') AND p.effective_from<=point AND(p.effective_to IS NULL OR p.effective_to>point) ORDER BY p.version DESC LIMIT 1)
   OR policy.value->>'timezone' IS DISTINCT FROM NEW.timezone OR NOT EXISTS(SELECT 1 FROM pg_timezone_names WHERE name=NEW.timezone)
   OR COALESCE(policy.value->>'proration','') NOT IN('FULL_CALENDAR_MONTH_ONLY','COMPLETE_ELIGIBLE_CALENDAR_DAYS')
   OR COALESCE(policy.value->>'rate_selection','') NOT IN('AT_FIRST_ELIGIBLE_DAY','DAILY_EFFECTIVE') OR policy.value->>'rounding' IS DISTINCT FROM 'HALF_UP_AT_PERIOD_TOTAL'
   OR NOT isfinite(NEW.from_on) OR NOT isfinite(NEW.to_on) OR NEW.from_on IS DISTINCT FROM date_trunc('month',NEW.from_on)::date
   OR NEW.to_on IS DISTINCT FROM(NEW.from_on+interval '1 month'-interval '1 day')::date OR((NEW.to_on+1)::timestamp AT TIME ZONE NEW.timezone)>point
   OR NEW.policy_snapshot IS DISTINCT FROM jsonb_build_object('schemaVersion',1,'policyRuleId',policy.id::text,'policyVersion',policy.version,'value',policy.value)
  THEN RAISE EXCEPTION 'monthly run requires its actual configured complete past contractual calendar';END IF;
  NEW.created_at=point;RETURN NEW;
 ELSIF NEW.earning_kind IS DISTINCT FROM 'PER_JOB' THEN RAISE EXCEPTION 'unsupported compensation run earning source';END IF;
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
END $function$;

CREATE OR REPLACE FUNCTION public.app_employee_compensation_run_line_admission()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE run employee_compensation_run%ROWTYPE; task operation_task%ROWTYPE; event operation_task_event%ROWTYPE;
 assignment role_assignment%ROWTYPE; contract team_compensation%ROWTYPE; rule config_rule%ROWTYPE; selected config_rule%ROWTYPE;
 subject person%ROWTYPE; villa property%ROWTYPE; role_key text;
BEGIN
 IF NEW.earning_kind='PER_HOUR' THEN PERFORM app_assert_employee_hourly_source(NEW);NEW.created_at=clock_timestamp();RETURN NEW;END IF;
 IF NEW.earning_kind='PER_MONTH' THEN PERFORM app_assert_employee_monthly_source(NEW);NEW.created_at=clock_timestamp();RETURN NEW;
 ELSIF NEW.earning_kind IS DISTINCT FROM 'PER_JOB' THEN RAISE EXCEPTION 'unsupported compensation earning source';END IF;
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
END $function$;

CREATE OR REPLACE FUNCTION public.app_employee_compensation_run_complete()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE run employee_compensation_run%ROWTYPE; line_count integer; total numeric;
BEGIN
 IF TG_TABLE_NAME='employee_compensation_run' THEN SELECT * INTO run FROM employee_compensation_run WHERE organization_id=NEW.organization_id AND id=NEW.id;
 ELSE SELECT * INTO run FROM employee_compensation_run WHERE organization_id=NEW.organization_id AND id=NEW.run_id; END IF;

 IF run.earning_kind='PER_HOUR' THEN IF TG_TABLE_NAME='employee_compensation_run_line' THEN PERFORM app_assert_employee_hourly_witnesses(NEW.organization_id,NEW.id);ELSE PERFORM app_assert_employee_hourly_run(run);END IF;RETURN NEW;END IF;
 IF run.earning_kind='PER_MONTH' THEN
  IF TG_TABLE_NAME='employee_compensation_run_line' THEN PERFORM app_assert_employee_monthly_witnesses(NEW.organization_id,NEW.id);RETURN NEW;END IF;
  SELECT count(*),sum(amount) INTO line_count,total FROM employee_compensation_run_line WHERE organization_id=run.organization_id AND run_id=run.id;
  IF line_count=0 OR EXISTS(SELECT 1 FROM employee_compensation_run_line WHERE organization_id=run.organization_id AND run_id=run.id AND earning_kind IS DISTINCT FROM 'PER_MONTH')
   OR(SELECT count(*) FROM audit_log a WHERE a.organization_id=run.organization_id AND a.resource_type='employee_compensation_run' AND a.resource_id=run.id AND a.action='finance.employee_compensation_run.created')<>1
   OR NOT EXISTS(SELECT 1 FROM audit_log a WHERE a.organization_id=run.organization_id AND a.resource_type='employee_compensation_run' AND a.resource_id=run.id AND a.action='finance.employee_compensation_run.created'
    AND a.actor_id=run.created_by AND a.reason=run.reason AND a.after=jsonb_build_object('runId',run.id::text,'kind','MONTHLY_CONTRACT_DRAFT','lineCount',line_count,'total',jsonb_build_object('amount',total::numeric(128,2)::text,'currency',run.currency)))
   OR NOT EXISTS(SELECT 1 FROM outbox_event e WHERE e.organization_id=run.organization_id AND e.type='EmployeeCompensationRunCreated' AND e.idempotency_key='employee-compensation-run:'||run.id::text||':created' AND e.payload=jsonb_build_object('runId',run.id::text))
  THEN RAISE EXCEPTION 'monthly run requires its complete actual sources and unique attributed receipt';END IF;RETURN NEW;
 END IF;
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
    AND COALESCE(a.state,'APPROVED')<>'REJECTED')
  THEN RAISE EXCEPTION 'completed work already belongs to an active employee claim'; END IF;
 END IF;
 NEW.created_at=clock_timestamp();RETURN NEW;
END $function$;
