-- AlterTable
ALTER TABLE "employee_compensation_cost" ALTER COLUMN "completion_event_id" DROP NOT NULL,
ALTER COLUMN "property_id" DROP NOT NULL;

-- AlterTable
ALTER TABLE "employee_compensation_run" ADD COLUMN     "earning_kind" VARCHAR(24) NOT NULL DEFAULT 'PER_JOB';

-- AlterTable
ALTER TABLE "employee_compensation_run_line" ADD COLUMN     "earning_kind" VARCHAR(24) NOT NULL DEFAULT 'PER_JOB',
ADD COLUMN     "earning_period_key" VARCHAR(120),
ADD COLUMN     "source_city_id" UUID,
ADD COLUMN     "source_region_id" UUID,
ALTER COLUMN "task_id" DROP NOT NULL,
ALTER COLUMN "completion_event_id" DROP NOT NULL,
ALTER COLUMN "property_id" DROP NOT NULL;

-- CreateTable
CREATE TABLE "employee_compensation_contract_witness" (
    "id" UUID NOT NULL DEFAULT app_uuid_v7(),
    "organization_id" UUID NOT NULL,
    "run_line_id" UUID NOT NULL,
    "source_on" DATE NOT NULL,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL,
    "eligible" BOOLEAN NOT NULL,
    "compensation_id" UUID,
    "config_rule_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "employee_compensation_contract_witness_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "employee_contract_witness_rate_idx" ON "employee_compensation_contract_witness"("organization_id", "compensation_id", "occurred_at");

-- CreateIndex
CREATE UNIQUE INDEX "employee_compensation_contract_witness_organization_id_id_key" ON "employee_compensation_contract_witness"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "employee_contract_witness_day_unique" ON "employee_compensation_contract_witness"("organization_id", "run_line_id", "source_on");

-- CreateIndex
CREATE UNIQUE INDEX "city_organization_id_id_key" ON "city"("organization_id", "id");

-- CreateIndex
CREATE INDEX "employee_run_monthly_source_idx" ON "employee_compensation_run_line"("organization_id", "assignment_id", "earning_period_key");

-- CreateIndex
CREATE UNIQUE INDEX "employee_run_monthly_assignment_unique" ON "employee_compensation_run_line"("organization_id", "run_id", "assignment_id", "earning_period_key");

-- CreateIndex
CREATE UNIQUE INDEX "region_organization_id_id_key" ON "region"("organization_id", "id");

-- AddForeignKey
ALTER TABLE "employee_compensation_run_line" ADD CONSTRAINT "employee_compensation_run_line_organization_id_source_city_fkey" FOREIGN KEY ("organization_id", "source_city_id") REFERENCES "city"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "employee_compensation_run_line" ADD CONSTRAINT "employee_compensation_run_line_organization_id_source_regi_fkey" FOREIGN KEY ("organization_id", "source_region_id") REFERENCES "region"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "employee_compensation_contract_witness" ADD CONSTRAINT "employee_compensation_contract_witness_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "employee_compensation_contract_witness" ADD CONSTRAINT "employee_compensation_contract_witness_organization_id_run_fkey" FOREIGN KEY ("organization_id", "run_line_id") REFERENCES "employee_compensation_run_line"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "employee_compensation_contract_witness" ADD CONSTRAINT "employee_compensation_contract_witness_organization_id_com_fkey" FOREIGN KEY ("organization_id", "compensation_id") REFERENCES "team_compensation"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "employee_compensation_contract_witness" ADD CONSTRAINT "employee_compensation_contract_witness_organization_id_con_fkey" FOREIGN KEY ("organization_id", "config_rule_id") REFERENCES "config_rule"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;


ALTER TABLE employee_compensation_run ADD CONSTRAINT employee_run_earning_kind CHECK(earning_kind IN('PER_JOB','PER_MONTH'));
ALTER TABLE employee_compensation_run_line DROP CONSTRAINT employee_compensation_run_line_fields;
ALTER TABLE employee_compensation_run_line ADD CONSTRAINT employee_compensation_run_line_fields CHECK(
 rate>=0 AND amount>=0 AND rate<>'NaN'::numeric AND amount<>'NaN'::numeric AND (
 (earning_kind='PER_JOB' AND rate=amount AND task_id IS NOT NULL AND completion_event_id IS NOT NULL AND property_id IS NOT NULL AND earning_period_key IS NULL AND source_city_id IS NULL AND source_region_id IS NULL)
 OR (earning_kind='PER_MONTH' AND completion_event_id IS NULL AND earning_period_key ~ '^\d{4}-(0[1-9]|1[0-2])$')));
ALTER TABLE employee_compensation_contract_witness ADD CONSTRAINT employee_contract_witness_shape CHECK(
 isfinite(source_on) AND isfinite(occurred_at) AND ((compensation_id IS NULL AND config_rule_id IS NULL AND eligible=false) OR(compensation_id IS NOT NULL AND config_rule_id IS NOT NULL)));
ALTER TABLE employee_compensation_contract_witness ENABLE ROW LEVEL SECURITY;
ALTER TABLE employee_compensation_contract_witness FORCE ROW LEVEL SECURITY;
CREATE POLICY employee_contract_witness_tenant_isolation ON employee_compensation_contract_witness
 USING(organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid)
 WITH CHECK(organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid);
CREATE TRIGGER employee_contract_witness_immutable BEFORE UPDATE OR DELETE ON employee_compensation_contract_witness FOR EACH ROW EXECUTE FUNCTION app_prevent_ledger_mutation();

CREATE FUNCTION app_assert_employee_monthly_source(v employee_compensation_run_line) RETURNS void LANGUAGE plpgsql
SET search_path TO public, pg_temp
AS $$
DECLARE h employee_compensation_run%ROWTYPE; a role_assignment%ROWTYPE; subject person%ROWTYPE; city_source city%ROWTYPE; job_source operation_task%ROWTYPE;
 day record; slot jsonb; day_count integer; eligible_count integer=0; weighted numeric=0; first_amount numeric; first_rate uuid; first_rule uuid; eligible_day boolean; source_xid text;
BEGIN
 SELECT * INTO h FROM employee_compensation_run WHERE organization_id=v.organization_id AND id=v.run_id;
 SELECT xmin::text INTO source_xid FROM employee_compensation_run WHERE organization_id=v.organization_id AND id=v.run_id;
 SELECT * INTO a FROM role_assignment WHERE organization_id=v.organization_id AND id=v.assignment_id;
 SELECT * INTO subject FROM person WHERE organization_id=v.organization_id AND id=v.person_id;
 IF h.id IS NULL OR h.earning_kind IS DISTINCT FROM 'PER_MONTH' OR source_xid::bigint<>mod(pg_current_xact_id()::text::numeric,4294967296)::bigint
  OR a.id IS NULL OR subject.id IS NULL OR a.person_id IS DISTINCT FROM v.person_id OR v.earning_kind IS DISTINCT FROM 'PER_MONTH'
  OR v.earning_period_key IS DISTINCT FROM to_char(h.from_on,'YYYY-MM') OR v.currency IS DISTINCT FROM h.currency OR v.completion_event_id IS NOT NULL
  OR v.recorded_completion_at IS DISTINCT FROM ((h.to_on+1)::timestamp AT TIME ZONE h.timezone)-interval '1 millisecond'
  OR v.source_snapshot->>'schemaVersion' IS DISTINCT FROM '1' OR v.source_snapshot->>'kind' IS DISTINCT FROM 'MONTHLY_CONTRACT_EARNINGS'
  OR v.source_snapshot->>'month' IS DISTINCT FROM v.earning_period_key OR v.source_snapshot->>'assignmentId' IS DISTINCT FROM a.id::text
  OR v.source_snapshot->>'personId' IS DISTINCT FROM subject.id::text OR v.source_snapshot->>'policyRuleId' IS DISTINCT FROM h.policy_rule_id::text
  OR v.source_snapshot->>'policyVersion' IS DISTINCT FROM h.policy_snapshot->>'policyVersion' OR v.source_snapshot->'policy' IS DISTINCT FROM h.policy_snapshot->'value'
  OR v.source_snapshot->'amount' IS DISTINCT FROM jsonb_build_object('amount',v.amount::text,'currency',v.currency)
  OR jsonb_typeof(v.source_snapshot->'days') IS DISTINCT FROM 'array'
 THEN RAISE EXCEPTION 'monthly source requires its actual immutable assignment and complete configured calendar';END IF;
 IF a.scope_type='organization' THEN
  IF v.property_id IS NOT NULL OR v.task_id IS NOT NULL OR v.source_city_id IS NOT NULL OR v.source_region_id IS NOT NULL THEN RAISE EXCEPTION 'organization monthly source cannot invent operational geography';END IF;
 ELSIF a.scope_type='property' THEN
  IF v.property_id IS DISTINCT FROM a.scope_id OR v.task_id IS NOT NULL OR v.source_city_id IS NOT NULL OR v.source_region_id IS NOT NULL THEN RAISE EXCEPTION 'monthly property source differs from its actual assignment';END IF;
 ELSIF a.scope_type='job' THEN
  SELECT * INTO job_source FROM operation_task WHERE organization_id=v.organization_id AND id=a.scope_id;
  IF job_source.id IS NULL OR v.task_id IS DISTINCT FROM job_source.id OR v.property_id IS DISTINCT FROM job_source.property_id OR v.source_city_id IS NOT NULL OR v.source_region_id IS NOT NULL THEN RAISE EXCEPTION 'monthly job scope requires its actual job without a fictitious completion';END IF;
 ELSIF a.scope_type='city' THEN
  SELECT * INTO city_source FROM city WHERE organization_id=v.organization_id AND id=a.scope_id;
  IF city_source.id IS NULL OR v.property_id IS NOT NULL OR v.task_id IS NOT NULL OR v.source_city_id IS DISTINCT FROM city_source.id OR v.source_region_id IS DISTINCT FROM city_source.region_id THEN RAISE EXCEPTION 'monthly city scope requires its actual tenant geography';END IF;
 ELSIF a.scope_type='region' THEN
  IF NOT EXISTS(SELECT 1 FROM region WHERE organization_id=v.organization_id AND id=a.scope_id) OR v.property_id IS NOT NULL OR v.task_id IS NOT NULL OR v.source_city_id IS NOT NULL OR v.source_region_id IS DISTINCT FROM a.scope_id THEN RAISE EXCEPTION 'monthly region scope requires its actual tenant geography';END IF;
 ELSE RAISE EXCEPTION 'unsupported monthly source scope';END IF;
 day_count=h.to_on-h.from_on+1;
 IF jsonb_array_length(v.source_snapshot->'days')<>day_count THEN RAISE EXCEPTION 'monthly source must retain every actual calendar day';END IF;
 FOR day IN
  SELECT d.on_date::date AS on_date,(d.on_date::timestamp AT TIME ZONE h.timezone) AS at,((d.on_date::date+1)::timestamp AT TIME ZONE h.timezone) AS until_at,
   c.id AS cid,c.config_rule_id AS cfg,c.version AS cv,c.mode AS mode,c.amount AS amount,c.currency AS currency,c.effective_from AS effective_from,
   r.id AS rid,r.version AS rv,r.value AS rule_value
  FROM generate_series(h.from_on::timestamp,h.to_on::timestamp,interval '1 day') AS d(on_date)
  LEFT JOIN LATERAL(SELECT x.* FROM team_compensation x WHERE x.organization_id=v.organization_id AND x.assignment_id=a.id AND x.effective_from<=(d.on_date::timestamp AT TIME ZONE h.timezone) ORDER BY x.version DESC LIMIT 1)c ON true
  LEFT JOIN LATERAL(SELECT x.* FROM config_rule x WHERE x.organization_id=v.organization_id AND x.key='staff.compensation' AND x.scope_type='role_assignment' AND x.scope_id=a.id
   AND x.archived_at IS NULL AND x.lifecycle IN('ACTIVE','RETIRED') AND x.effective_from<=(d.on_date::timestamp AT TIME ZONE h.timezone)
   AND(x.effective_to IS NULL OR x.effective_to>(d.on_date::timestamp AT TIME ZONE h.timezone)) ORDER BY x.version DESC LIMIT 1)r ON true
  ORDER BY d.on_date
 LOOP
  slot=v.source_snapshot->'days'->(day.on_date-h.from_on);
  eligible_day=a.valid_from<=day.at AND(a.valid_to IS NULL OR a.valid_to>=day.until_at) AND(a.archived_at IS NULL OR a.archived_at>=day.until_at)
   AND(subject.archived_at IS NULL OR subject.archived_at>=day.until_at) AND COALESCE(day.mode='PER_MONTH',false);
  IF slot->>'on' IS DISTINCT FROM day.on_date::text OR slot->'eligible' IS DISTINCT FROM to_jsonb(eligible_day)
   OR slot#>>'{assignment,id}' IS DISTINCT FROM a.id::text OR slot#>>'{assignment,personId}' IS DISTINCT FROM a.person_id::text
   OR slot#>>'{assignment,roleId}' IS DISTINCT FROM a.role_id::text OR slot#>>'{assignment,scopeType}' IS DISTINCT FROM a.scope_type OR slot#>>'{assignment,scopeId}' IS DISTINCT FROM a.scope_id::text
   OR slot#>>'{compensation,id}' IS DISTINCT FROM day.cid::text
  THEN RAISE EXCEPTION 'monthly source must retain actual complete-day eligibility and contractual identities';END IF;
  IF day.cid IS NULL THEN
   IF slot->'compensation' IS DISTINCT FROM 'null'::jsonb OR slot->'rule' IS DISTINCT FROM 'null'::jsonb THEN RAISE EXCEPTION 'an uncontracted day cannot invent a rate';END IF;
  ELSE
   IF day.rid IS NULL OR day.rid IS DISTINCT FROM day.cfg OR slot#>>'{compensation,configRuleId}' IS DISTINCT FROM day.cfg::text
    OR slot#>>'{compensation,version}' IS DISTINCT FROM day.cv::text OR slot#>>'{compensation,mode}' IS DISTINCT FROM day.mode
    OR(slot#>>'{compensation,amount}')::numeric IS DISTINCT FROM day.amount OR slot#>>'{compensation,currency}' IS DISTINCT FROM day.currency
    OR(slot#>>'{compensation,effectiveFrom}')::timestamptz IS DISTINCT FROM date_trunc('milliseconds',day.effective_from)
    OR slot#>>'{rule,id}' IS DISTINCT FROM day.rid::text OR slot#>>'{rule,version}' IS DISTINCT FROM day.rv::text
    OR slot#>>'{rule,scopeType}' IS DISTINCT FROM 'role_assignment' OR slot#>>'{rule,scopeId}' IS DISTINCT FROM a.id::text OR slot#>'{rule,value}' IS DISTINCT FROM day.rule_value
    OR day.rule_value->>'mode' IS DISTINCT FROM day.mode OR(day.rule_value->>'amount')::numeric IS DISTINCT FROM day.amount OR day.rule_value->>'currency' IS DISTINCT FROM day.currency
   THEN RAISE EXCEPTION 'monthly source cannot substitute an effective contractual rate or configuration';END IF;
  END IF;
  IF eligible_day THEN
   IF day.currency IS DISTINCT FROM v.currency OR day.amount<0 OR day.amount='NaN'::numeric THEN RAISE EXCEPTION 'monthly source requires nonnegative same-currency contracts';END IF;
   eligible_count=eligible_count+1;
   IF first_rate IS NULL THEN first_rate=day.cid;first_rule=day.cfg;first_amount=day.amount;END IF;
   weighted=weighted+CASE WHEN h.policy_snapshot#>>'{value,rate_selection}'='AT_FIRST_ELIGIBLE_DAY' THEN first_amount ELSE day.amount END;
  END IF;
 END LOOP;
 IF eligible_count=0 OR(h.policy_snapshot#>>'{value,proration}'='FULL_CALENDAR_MONTH_ONLY' AND eligible_count<>day_count)
  OR v.compensation_id IS DISTINCT FROM first_rate OR v.config_rule_id IS DISTINCT FROM first_rule OR v.rate IS DISTINCT FROM first_amount
  OR v.amount IS DISTINCT FROM round(weighted/day_count,2)
 THEN RAISE EXCEPTION 'monthly source must conserve the configured exact original period amount';END IF;
END $$;

CREATE FUNCTION app_employee_contract_witness_admission() RETURNS trigger LANGUAGE plpgsql
SET search_path TO public, pg_temp
AS $$
DECLARE l employee_compensation_run_line%ROWTYPE; h employee_compensation_run%ROWTYPE; slot jsonb; source_xid text;
BEGIN
 SELECT * INTO l FROM employee_compensation_run_line WHERE organization_id=NEW.organization_id AND id=NEW.run_line_id;
 SELECT xmin::text INTO source_xid FROM employee_compensation_run_line WHERE organization_id=NEW.organization_id AND id=NEW.run_line_id;
 SELECT * INTO h FROM employee_compensation_run WHERE organization_id=NEW.organization_id AND id=l.run_id;
 slot=l.source_snapshot->'days'->(NEW.source_on-h.from_on);
 IF l.id IS NULL OR l.earning_kind IS DISTINCT FROM 'PER_MONTH' OR source_xid::bigint<>mod(pg_current_xact_id()::text::numeric,4294967296)::bigint
  OR NEW.source_on NOT BETWEEN h.from_on AND h.to_on OR NEW.occurred_at IS DISTINCT FROM(NEW.source_on::timestamp AT TIME ZONE h.timezone)
  OR slot->>'on' IS DISTINCT FROM NEW.source_on::text OR slot->'eligible' IS DISTINCT FROM to_jsonb(NEW.eligible)
  OR slot#>>'{compensation,id}' IS DISTINCT FROM NEW.compensation_id::text OR slot#>>'{rule,id}' IS DISTINCT FROM NEW.config_rule_id::text
 THEN RAISE EXCEPTION 'daily contract witnesses belong only to their original actual monthly source';END IF;
 NEW.created_at=clock_timestamp();RETURN NEW;
END $$;
CREATE TRIGGER employee_contract_witness_admission BEFORE INSERT ON employee_compensation_contract_witness FOR EACH ROW EXECUTE FUNCTION app_employee_contract_witness_admission();

CREATE FUNCTION app_assert_employee_monthly_witnesses(org_uuid uuid,line_uuid uuid) RETURNS void LANGUAGE plpgsql
SET search_path TO public, pg_temp
AS $$
DECLARE l employee_compensation_run_line%ROWTYPE; h employee_compensation_run%ROWTYPE;
BEGIN
 SELECT * INTO l FROM employee_compensation_run_line WHERE organization_id=org_uuid AND id=line_uuid;
 SELECT * INTO h FROM employee_compensation_run WHERE organization_id=org_uuid AND id=l.run_id;
 IF l.earning_kind IS DISTINCT FROM 'PER_MONTH' THEN
  IF EXISTS(SELECT 1 FROM employee_compensation_contract_witness WHERE organization_id=org_uuid AND run_line_id=l.id) THEN RAISE EXCEPTION 'completed-job records cannot invent monthly witnesses';END IF;RETURN;
 END IF;
 PERFORM app_assert_employee_monthly_source(l);
 IF(SELECT count(*) FROM employee_compensation_contract_witness WHERE organization_id=org_uuid AND run_line_id=l.id)<>(h.to_on-h.from_on+1)
 THEN RAISE EXCEPTION 'a monthly source requires all original immutable daily contract witnesses';END IF;
END $$;

CREATE OR REPLACE FUNCTION public.app_employee_compensation_run_admission()
 RETURNS trigger
 LANGUAGE plpgsql
SET search_path TO public, pg_temp
AS $function$
DECLARE policy config_rule%ROWTYPE; point timestamptz;
BEGIN

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
SET search_path TO public, pg_temp
AS $function$
DECLARE run employee_compensation_run%ROWTYPE; task operation_task%ROWTYPE; event operation_task_event%ROWTYPE;
 assignment role_assignment%ROWTYPE; contract team_compensation%ROWTYPE; rule config_rule%ROWTYPE; selected config_rule%ROWTYPE;
 subject person%ROWTYPE; villa property%ROWTYPE; role_key text;
BEGIN
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
SET search_path TO public, pg_temp
AS $function$
DECLARE run employee_compensation_run%ROWTYPE; line_count integer; total numeric;
BEGIN
 IF TG_TABLE_NAME='employee_compensation_run' THEN SELECT * INTO run FROM employee_compensation_run WHERE organization_id=NEW.organization_id AND id=NEW.id;
 ELSE SELECT * INTO run FROM employee_compensation_run WHERE organization_id=NEW.organization_id AND id=NEW.run_id; END IF;

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
SET search_path TO public, pg_temp
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
   WHERE old_cost.organization_id=NEW.organization_id AND ((l.earning_kind='PER_JOB' AND old_cost.completion_event_id=NEW.completion_event_id) OR(l.earning_kind='PER_MONTH' AND EXISTS(SELECT 1 FROM employee_compensation_run_line prior_line WHERE prior_line.organization_id=old_cost.organization_id AND prior_line.id=old_cost.run_line_id AND prior_line.earning_kind='PER_MONTH' AND prior_line.assignment_id=l.assignment_id AND prior_line.earning_period_key=l.earning_period_key))) AND prior.id<>s.id
    AND NOT EXISTS(SELECT 1 FROM employee_compensation_withdrawal w WHERE w.organization_id=prior.organization_id AND w.submission_id=prior.id)
    AND COALESCE(a.state,'APPROVED')<>'REJECTED')
  THEN RAISE EXCEPTION 'completed work already belongs to an active employee claim'; END IF;
 END IF;
 NEW.created_at=clock_timestamp();RETURN NEW;
END $function$;

CREATE OR REPLACE FUNCTION public.app_assert_employee_recognition_line(org_uuid uuid, line_uuid uuid)
 RETURNS void
 LANGUAGE plpgsql
SET search_path TO public, pg_temp
AS $function$
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

 IF EXISTS(SELECT 1 FROM employee_compensation_run_line x JOIN posting p ON p.organization_id=x.organization_id AND p.transaction_id=t.id
   WHERE x.organization_id=org_uuid AND x.id=l.run_line_id AND x.earning_kind='PER_MONTH' AND(
    p.dimensions->>'employee_compensation_earning_kind' IS DISTINCT FROM 'PER_MONTH' OR p.dimensions->>'employee_compensation_assignment_id' IS DISTINCT FROM x.assignment_id::text
    OR p.dimensions->>'employee_compensation_earning_period' IS DISTINCT FROM x.earning_period_key OR p.dimensions ? 'completion_event_id' OR(x.property_id IS NULL AND p.dimensions ? 'property_id')))
 THEN RAISE EXCEPTION 'monthly recognition retains actual contractual dimensions without a fictitious job';END IF;
 IF expected_count<>(SELECT count(*) FROM posting WHERE organization_id=org_uuid AND transaction_id=t.id)
 THEN RAISE EXCEPTION 'employee recognition cannot add or omit financial movements'; END IF;
END $function$;
