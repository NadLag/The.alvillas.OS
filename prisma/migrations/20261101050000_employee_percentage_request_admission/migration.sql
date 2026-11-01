BEGIN;
-- AlterTable
ALTER TABLE "employee_earning_request_work" ADD COLUMN     "property_id" UUID,
ADD COLUMN     "source_city_id" UUID,
ADD COLUMN     "source_region_id" UUID,
ADD COLUMN     "task_id" UUID,
ALTER COLUMN "evidence_id" DROP NOT NULL,
ALTER COLUMN "decision_id" DROP NOT NULL;

-- CreateTable
CREATE TABLE "employee_earning_request_percentage_witness" (
    "id" UUID NOT NULL DEFAULT app_uuid_v7(),
    "organization_id" UUID NOT NULL,
    "source_id" UUID NOT NULL,
    "posting_id" UUID NOT NULL,
    "compensation_id" UUID NOT NULL,
    "config_rule_id" UUID NOT NULL,
    "policy_rule_id" UUID NOT NULL,
    "position" INTEGER NOT NULL,
    "is_earning_base" BOOLEAN NOT NULL,
    "journal_amount" DECIMAL(128,2) NOT NULL,
    "property_id" UUID,
    "source_city_id" UUID,
    "source_region_id" UUID,
    "reservation_id" UUID,
    "task_id" UUID,
    "owner_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "employee_earning_request_percentage_witness_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "employee_earning_percentage_posting_idx" ON "employee_earning_request_percentage_witness"("organization_id", "posting_id", "source_id");

-- CreateIndex
CREATE INDEX "employee_earning_percentage_contract_idx" ON "employee_earning_request_percentage_witness"("organization_id", "compensation_id");

-- CreateIndex
CREATE INDEX "employee_earning_percentage_policy_idx" ON "employee_earning_request_percentage_witness"("organization_id", "policy_rule_id");

-- CreateIndex
CREATE UNIQUE INDEX "employee_earning_percentage_org_id_unique" ON "employee_earning_request_percentage_witness"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "employee_earning_percentage_position_unique" ON "employee_earning_request_percentage_witness"("organization_id", "source_id", "position");

-- CreateIndex
CREATE UNIQUE INDEX "employee_earning_percentage_line_posting_unique" ON "employee_earning_request_percentage_witness"("organization_id", "source_id", "posting_id");

-- AddForeignKey
ALTER TABLE "employee_earning_request_work" ADD CONSTRAINT "employee_earning_work_property_fk" FOREIGN KEY ("organization_id", "property_id") REFERENCES "property"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "employee_earning_request_work" ADD CONSTRAINT "employee_earning_work_city_fk" FOREIGN KEY ("organization_id", "source_city_id") REFERENCES "city"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "employee_earning_request_work" ADD CONSTRAINT "employee_earning_work_region_fk" FOREIGN KEY ("organization_id", "source_region_id") REFERENCES "region"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "employee_earning_request_work" ADD CONSTRAINT "employee_earning_work_task_fk" FOREIGN KEY ("organization_id", "task_id") REFERENCES "operation_task"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "employee_earning_request_percentage_witness" ADD CONSTRAINT "employee_earning_request_percentage_witness_organization_i_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "employee_earning_request_percentage_witness" ADD CONSTRAINT "employee_earning_percentage_line_fk" FOREIGN KEY ("organization_id", "source_id") REFERENCES "employee_earning_request_work"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "employee_earning_request_percentage_witness" ADD CONSTRAINT "employee_earning_percentage_posting_fk" FOREIGN KEY ("organization_id", "posting_id") REFERENCES "posting"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "employee_earning_request_percentage_witness" ADD CONSTRAINT "employee_earning_percentage_contract_fk" FOREIGN KEY ("organization_id", "compensation_id") REFERENCES "team_compensation"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "employee_earning_request_percentage_witness" ADD CONSTRAINT "employee_earning_percentage_rate_rule_fk" FOREIGN KEY ("organization_id", "config_rule_id") REFERENCES "config_rule"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "employee_earning_request_percentage_witness" ADD CONSTRAINT "employee_earning_percentage_policy_fk" FOREIGN KEY ("organization_id", "policy_rule_id") REFERENCES "config_rule"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "employee_earning_request_percentage_witness" ADD CONSTRAINT "employee_earning_percentage_property_fk" FOREIGN KEY ("organization_id", "property_id") REFERENCES "property"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "employee_earning_request_percentage_witness" ADD CONSTRAINT "employee_earning_percentage_city_fk" FOREIGN KEY ("organization_id", "source_city_id") REFERENCES "city"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "employee_earning_request_percentage_witness" ADD CONSTRAINT "employee_earning_percentage_region_fk" FOREIGN KEY ("organization_id", "source_region_id") REFERENCES "region"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "employee_earning_request_percentage_witness" ADD CONSTRAINT "employee_earning_percentage_reservation_fk" FOREIGN KEY ("organization_id", "reservation_id") REFERENCES "reservation"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "employee_earning_request_percentage_witness" ADD CONSTRAINT "employee_earning_percentage_task_fk" FOREIGN KEY ("organization_id", "task_id") REFERENCES "operation_task"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "employee_earning_request_percentage_witness" ADD CONSTRAINT "employee_earning_percentage_owner_fk" FOREIGN KEY ("organization_id", "owner_id") REFERENCES "owner"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;


CREATE VIEW employee_percentage_posting_witness WITH(security_invoker=true,security_barrier=true) AS
 SELECT 'RUN'::text owner_kind,w.run_line_id witness_owner_id,w.run_line_id,w.id,w.organization_id,w.posting_id,w.compensation_id,w.config_rule_id,w.policy_rule_id,w.position,w.is_earning_base,w.journal_amount,w.property_id,w.source_city_id,w.source_region_id,w.reservation_id,w.task_id,w.owner_id,w.created_at,w.xmin row_birth FROM employee_compensation_percentage_witness w
 UNION ALL SELECT 'REQUEST'::text owner_kind,w.source_id witness_owner_id,w.source_id run_line_id,w.id,w.organization_id,w.posting_id,w.compensation_id,w.config_rule_id,w.policy_rule_id,w.position,w.is_earning_base,w.journal_amount,w.property_id,w.source_city_id,w.source_region_id,w.reservation_id,w.task_id,w.owner_id,w.created_at,w.xmin row_birth FROM employee_earning_request_percentage_witness w;
CREATE FUNCTION app_employee_percentage_posting_witnesses(p_owner_kind text,org_uuid uuid,line_uuid uuid)
 RETURNS SETOF employee_percentage_posting_witness LANGUAGE sql STABLE SET search_path=public,pg_temp AS $$
 SELECT * FROM employee_percentage_posting_witness WHERE owner_kind=$1 AND organization_id=$2 AND witness_owner_id=$3
$$;
CREATE OR REPLACE FUNCTION public.app_assert_employee_percentage_line_origin(l employee_compensation_run_line, h employee_compensation_run)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE a role_assignment%ROWTYPE;j operation_task%ROWTYPE;
BEGIN

 SELECT * INTO a FROM role_assignment WHERE organization_id=l.organization_id AND id=l.assignment_id;
 SELECT * INTO j FROM operation_task WHERE organization_id=l.organization_id AND id=a.scope_id AND a.scope_type='job';
 IF h.id IS NULL OR h.earning_kind<>'PERCENTAGE' OR a.id IS NULL OR a.person_id<>l.person_id OR l.currency<>h.currency
  OR l.completion_event_id IS NOT NULL OR l.earning_period_key IS NOT NULL OR l.work_time_evidence_id IS NOT NULL OR l.work_time_decision_id IS NOT NULL
  OR jsonb_typeof(l.source_snapshot->'witnesses') IS DISTINCT FROM 'array'
  OR NOT(a.scope_type='organization' AND ROW(l.property_id,l.task_id,l.source_city_id,l.source_region_id) IS NOT DISTINCT FROM ROW(NULL::uuid,NULL::uuid,NULL::uuid,NULL::uuid)
   OR a.scope_type='property' AND ROW(l.property_id,l.task_id,l.source_city_id,l.source_region_id) IS NOT DISTINCT FROM ROW(a.scope_id,NULL::uuid,NULL::uuid,NULL::uuid)
   OR a.scope_type='city' AND ROW(l.property_id,l.task_id,l.source_city_id,l.source_region_id) IS NOT DISTINCT FROM ROW(NULL::uuid,NULL::uuid,a.scope_id,NULL::uuid)
   OR a.scope_type='region' AND ROW(l.property_id,l.task_id,l.source_city_id,l.source_region_id) IS NOT DISTINCT FROM ROW(NULL::uuid,NULL::uuid,NULL::uuid,a.scope_id)
   OR a.scope_type='job' AND j.id IS NOT NULL AND ROW(l.property_id,l.task_id,l.source_city_id,l.source_region_id) IS NOT DISTINCT FROM ROW(j.property_id,j.id,NULL::uuid,NULL::uuid))
  OR EXISTS(SELECT 1 FROM audit_log WHERE organization_id=h.organization_id AND resource_type='employee_compensation_run' AND resource_id=h.id AND action='finance.employee_compensation_run.created')
  OR EXISTS(SELECT 1 FROM outbox_event WHERE organization_id=h.organization_id AND type='EmployeeCompensationRunCreated' AND idempotency_key='employee-compensation-run:'||h.id::text||':created')
 THEN RAISE EXCEPTION 'percentage lines require their actual same-birth contract scope before the immutable creation receipt';END IF;
END $function$;
CREATE OR REPLACE FUNCTION app_assert_employee_percentage_line_header(l employee_compensation_run_line) RETURNS void LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
 DECLARE h employee_compensation_run%ROWTYPE;BEGIN SELECT * INTO h FROM employee_compensation_run WHERE organization_id=l.organization_id AND id=l.run_id;PERFORM app_assert_employee_percentage_line_origin(l,h);END $$;
CREATE OR REPLACE FUNCTION public.app_assert_employee_percentage_witnesses_for(p_owner_kind text, org_uuid uuid, line_uuid uuid)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE l employee_compensation_run_line%ROWTYPE;h employee_compensation_run%ROWTYPE;a role_assignment%ROWTYPE;subject person%ROWTYPE;
 policy config_rule%ROWTYPE;selected uuid;selected_rule uuid;born xid;w record;slot jsonb;refs jsonb;expected jsonb;
 task_row operation_task%ROWTYPE;reservation_row reservation%ROWTYPE;property_row property%ROWTYPE;
 task_uuid uuid;reservation_uuid uuid;property_uuid uuid;owner_uuid uuid;total numeric:=0;last_at timestamptz;
 n integer;base_count integer;first_base record;has_base boolean:=false;seen_count integer:=0;
BEGIN
 IF p_owner_kind='RUN' THEN
 SELECT * INTO l FROM employee_compensation_run_line WHERE organization_id=org_uuid AND id=line_uuid;
 SELECT xmin INTO born FROM employee_compensation_run_line WHERE organization_id=org_uuid AND id=line_uuid;
 SELECT * INTO h FROM employee_compensation_run WHERE organization_id=org_uuid AND id=l.run_id;
 ELSIF p_owner_kind='REQUEST' THEN
 SELECT(jsonb_populate_record(NULL::employee_compensation_run_line,to_jsonb(s)||jsonb_build_object('run_id',s.request_id,'earning_kind','PERCENTAGE'))).* INTO l
 FROM employee_earning_request_work s WHERE s.organization_id=org_uuid AND s.id=line_uuid AND s.evidence_id IS NULL AND s.decision_id IS NULL;
 SELECT xmin INTO born FROM employee_earning_request_work WHERE organization_id=org_uuid AND id=line_uuid;
 SELECT(jsonb_populate_record(NULL::employee_compensation_run,to_jsonb(q)||jsonb_build_object('created_by',q.requested_by,'created_at',q.requested_at))).* INTO h
 FROM employee_earning_run_request q WHERE q.organization_id=org_uuid AND q.id=l.run_id;
 PERFORM app_assert_employee_percentage_line_origin(l,h);
 ELSE RAISE EXCEPTION 'unsupported original percentage witness owner';END IF;
 SELECT * INTO a FROM role_assignment WHERE organization_id=org_uuid AND id=l.assignment_id;
 SELECT * INTO subject FROM person WHERE organization_id=org_uuid AND id=l.person_id;
 IF l.id IS NULL OR h.id IS NULL OR a.id IS NULL OR subject.id IS NULL OR l.earning_kind<>'PERCENTAGE' OR h.earning_kind<>'PERCENTAGE'
  OR a.person_id<>l.person_id OR l.currency<>h.currency THEN RAISE EXCEPTION 'percentage source line requires its actual tenant header and beneficiary assignment';END IF;
 SELECT count(*),count(*) FILTER(WHERE is_earning_base) INTO n,base_count FROM app_employee_percentage_posting_witnesses(p_owner_kind,org_uuid,line_uuid) WHERE organization_id=org_uuid AND run_line_id=line_uuid;
 IF n=0 OR base_count=0 OR n<>jsonb_array_length(l.source_snapshot->'witnesses')
  OR EXISTS(SELECT 1 FROM app_employee_percentage_posting_witnesses(p_owner_kind,org_uuid,line_uuid) WHERE organization_id=org_uuid AND run_line_id=line_uuid AND(row_birth<>born OR position>=n))
 THEN RAISE EXCEPTION 'percentage source requires every original same-birth posting witness';END IF;
 SELECT p.* INTO policy FROM config_rule p JOIN app_employee_percentage_posting_witnesses(p_owner_kind,org_uuid,line_uuid) policy_witness ON policy_witness.organization_id=p.organization_id AND policy_witness.policy_rule_id=p.id
  WHERE policy_witness.organization_id=org_uuid AND policy_witness.run_line_id=line_uuid ORDER BY policy_witness.position LIMIT 1;
 SELECT id INTO selected FROM config_rule WHERE organization_id=org_uuid AND key='staff.compensation_percentage_earnings' AND scope_type='organization' AND scope_id IS NULL
  AND archived_at IS NULL AND lifecycle IN('ACTIVE','RETIRED') AND effective_from<=h.created_at AND(effective_to IS NULL OR effective_to>h.created_at)
  ORDER BY effective_from DESC,version DESC LIMIT 1;
 IF policy.id IS NULL OR policy.id IS DISTINCT FROM selected OR policy.value->>'evidence' IS DISTINCT FROM 'IMMUTABLE_POSTED_FINANCIAL_BASES'
  OR policy.value->>'rate_selection' IS DISTINCT FROM 'AT_ACTUAL_BASE_INSTANT' OR policy.value->>'rounding' IS DISTINCT FROM 'HALF_UP_AT_EARNING_TOTAL'
  OR COALESCE(policy.value->>'base_side','') NOT IN('DEBIT','CREDIT') OR jsonb_typeof(policy.value->'base_buckets') IS DISTINCT FROM 'array'
  OR jsonb_array_length(policy.value->'base_buckets')=0 OR(policy.value-'evidence'-'rate_selection'-'rounding'-'base_side'-'base_buckets')<>'{}'::jsonb
 THEN RAISE EXCEPTION 'percentage earning requires its actual original configured posted-base policy';END IF;
 FOR w IN SELECT x.*,p.transaction_id,p.ledger_account_id,p.side,p.amount posting_amount,p.currency posting_currency,p.bucket,p.dimensions,
  t.occurred_at,t.sealed,t.reverses_transaction_id,c.assignment_id,c.config_rule_id original_rule,c.mode,c.amount rate_amount,c.currency rate_currency,c.version compensation_version,c.effective_from,
  r.version config_version,r.key rule_key,r.scope_type,r.scope_id,r.value,r.effective_from rule_from,r.effective_to rule_to,r.archived_at rule_archived,r.lifecycle rule_lifecycle
  FROM app_employee_percentage_posting_witnesses(p_owner_kind,org_uuid,line_uuid) x JOIN posting p ON p.organization_id=x.organization_id AND p.id=x.posting_id
  JOIN financial_transaction t ON t.organization_id=p.organization_id AND t.id=p.transaction_id
  JOIN ledger_account k ON k.organization_id=p.organization_id AND k.id=p.ledger_account_id
  JOIN team_compensation c ON c.organization_id=x.organization_id AND c.id=x.compensation_id
  JOIN config_rule r ON r.organization_id=x.organization_id AND r.id=x.config_rule_id
  WHERE x.organization_id=org_uuid AND x.run_line_id=line_uuid ORDER BY x.position LOOP
  seen_count=seen_count+1;
  IF w.journal_amount IS DISTINCT FROM(SELECT COALESCE(sum(amount),0) FROM posting WHERE organization_id=org_uuid AND transaction_id=w.transaction_id AND currency=w.posting_currency AND side='DEBIT')
  THEN RAISE EXCEPTION 'percentage authority must retain the complete original same-currency journal amount';END IF;
  IF NOT w.sealed OR w.reverses_transaction_id IS NOT NULL OR EXISTS(SELECT 1 FROM financial_transaction WHERE organization_id=org_uuid AND reverses_transaction_id=w.transaction_id)
   OR w.occurred_at<(h.from_on::timestamp AT TIME ZONE h.timezone) OR w.occurred_at>=((h.to_on+1)::timestamp AT TIME ZONE h.timezone)
   OR w.occurred_at>h.created_at OR date_trunc('milliseconds',w.occurred_at)<>w.occurred_at
   OR w.policy_rule_id<>policy.id OR w.assignment_id<>a.id OR w.original_rule<>w.config_rule_id OR w.mode<>'PERCENTAGE' OR w.rate_currency<>l.currency
   OR w.rate_amount<0 OR w.rate_amount>100 OR w.rate_amount='NaN'::numeric OR w.effective_from IS DISTINCT FROM w.rule_from
   OR w.rule_key<>'staff.compensation' OR w.scope_type<>'role_assignment' OR w.scope_id IS DISTINCT FROM a.id OR w.rule_archived IS NOT NULL OR w.rule_lifecycle NOT IN('ACTIVE','RETIRED')
   OR w.rule_from>w.occurred_at OR w.rule_to<=w.occurred_at OR w.value->>'mode' IS DISTINCT FROM 'PERCENTAGE' OR w.value->>'currency' IS DISTINCT FROM l.currency::text
   OR(w.value->>'amount')::numeric IS DISTINCT FROM w.rate_amount OR a.valid_from>w.occurred_at OR a.valid_to<=w.occurred_at OR a.archived_at<=w.occurred_at OR subject.archived_at<=w.occurred_at
  THEN RAISE EXCEPTION 'percentage witnesses require actual original unreversed postings and exact effective contracts';END IF;
  SELECT id INTO selected FROM team_compensation WHERE organization_id=org_uuid AND assignment_id=a.id AND effective_from<=w.occurred_at ORDER BY version DESC LIMIT 1;
  SELECT id INTO selected_rule FROM config_rule WHERE organization_id=org_uuid AND key='staff.compensation' AND scope_type='role_assignment' AND scope_id=a.id
   AND archived_at IS NULL AND lifecycle IN('ACTIVE','RETIRED') AND effective_from<=w.occurred_at AND(effective_to IS NULL OR effective_to>w.occurred_at) ORDER BY effective_from DESC,version DESC LIMIT 1;
  IF w.compensation_id IS DISTINCT FROM selected OR w.config_rule_id IS DISTINCT FROM selected_rule THEN RAISE EXCEPTION 'percentage witness must retain the actual original rate and configuration';END IF;
  refs=COALESCE(w.dimensions,'{}'::jsonb);
  IF jsonb_typeof(refs)<>'object' OR refs->>'task_id' IS NOT NULL AND refs->>'job_id' IS NOT NULL AND(refs->>'task_id')::uuid<>(refs->>'job_id')::uuid THEN RAISE EXCEPTION 'percentage posting scope references are invalid';END IF;
  task_uuid=COALESCE(refs->>'task_id',refs->>'job_id')::uuid;
  SELECT * INTO task_row FROM operation_task WHERE organization_id=org_uuid AND id=task_uuid;
  reservation_uuid=COALESCE((refs->>'reservation_id')::uuid,task_row.reservation_id);
  SELECT * INTO reservation_row FROM reservation WHERE organization_id=org_uuid AND id=reservation_uuid;
  property_uuid=COALESCE((refs->>'property_id')::uuid,reservation_row.property_id,task_row.property_id);
  SELECT * INTO property_row FROM property WHERE organization_id=org_uuid AND id=property_uuid;
  owner_uuid=(refs->>'owner_id')::uuid;
  IF task_uuid IS NOT NULL AND task_row.id IS NULL OR reservation_uuid IS NOT NULL AND reservation_row.id IS NULL OR property_uuid IS NOT NULL AND property_row.id IS NULL
   OR owner_uuid IS NOT NULL AND NOT EXISTS(SELECT 1 FROM owner WHERE organization_id=org_uuid AND id=owner_uuid)
   OR task_row.id IS NOT NULL AND refs->>'reservation_id' IS NOT NULL AND task_row.reservation_id IS DISTINCT FROM reservation_uuid
   OR reservation_row.id IS NOT NULL AND reservation_row.property_id IS DISTINCT FROM property_uuid OR task_row.id IS NOT NULL AND task_row.property_id IS DISTINCT FROM property_uuid
   OR ROW(w.property_id,w.source_city_id,w.source_region_id,w.reservation_id,w.task_id,w.owner_id) IS DISTINCT FROM ROW(property_uuid,property_row.city_id,property_row.region_id,reservation_uuid,task_uuid,owner_uuid)
  THEN RAISE EXCEPTION 'percentage witness scope must resolve through its actual tenant posting references';END IF;
  IF w.is_earning_base THEN
   IF w.posting_currency<>l.currency OR w.posting_amount<=0 OR w.posting_amount='NaN'::numeric OR w.side IS DISTINCT FROM policy.value->>'base_side'
    OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements_text(policy.value->'base_buckets') b WHERE b=w.bucket)
    OR NOT(a.scope_type='organization' OR a.scope_type='property' AND a.scope_id=property_uuid OR a.scope_type='city' AND a.scope_id=property_row.city_id
     OR a.scope_type='region' AND a.scope_id=property_row.region_id OR a.scope_type='job' AND a.scope_id=task_uuid)
   THEN RAISE EXCEPTION 'percentage bases require configured positive same-currency original postings within the actual contract scope';END IF;
   total=total+w.posting_amount*w.rate_amount/100;
   IF NOT has_base THEN first_base=w;has_base=true;END IF;
   IF last_at IS NULL OR w.occurred_at>last_at THEN last_at=w.occurred_at;END IF;
  END IF;
  slot=l.source_snapshot->'witnesses'->w.position;
  expected=jsonb_build_object('postingId',w.posting_id::text,'transactionId',w.transaction_id::text,'ledgerAccountId',w.ledger_account_id::text,'compensationId',w.compensation_id::text,
   'configRuleId',w.config_rule_id::text,'compensationVersion',w.compensation_version,'configVersion',w.config_version,'isEarningBase',w.is_earning_base,
   'occurredAt',to_char(w.occurred_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'postingAmount',jsonb_build_object('amount',w.posting_amount::numeric(18,2)::text,'currency',w.posting_currency),
   'rate',jsonb_build_object('amount',w.rate_amount::numeric(18,2)::text,'currency',w.rate_currency),'journalAmount',jsonb_build_object('amount',w.journal_amount::numeric(128,2)::text,'currency',w.posting_currency),'bucket',w.bucket,'side',w.side,
   'propertyId',property_uuid::text,'sourceCityId',property_row.city_id::text,'sourceRegionId',property_row.region_id::text,'reservationId',reservation_uuid::text,'taskId',task_uuid::text,'ownerId',owner_uuid::text);
  IF slot IS DISTINCT FROM expected THEN RAISE EXCEPTION 'percentage snapshot must retain each exact original economic source and contract';END IF;
 END LOOP;
 IF seen_count<>n OR NOT has_base THEN RAISE EXCEPTION 'every percentage witness requires its actual tenant journal and original contract';END IF;
 IF l.compensation_id IS DISTINCT FROM first_base.compensation_id OR l.config_rule_id IS DISTINCT FROM first_base.config_rule_id OR l.rate IS DISTINCT FROM first_base.rate_amount
  OR l.amount IS DISTINCT FROM round(total,2) OR l.recorded_completion_at IS DISTINCT FROM last_at
  OR(l.source_snapshot-'witnesses') IS DISTINCT FROM jsonb_build_object('schemaVersion',1,'kind','ACTUAL_POSTED_PERCENTAGE_EARNINGS','personId',l.person_id::text,'assignmentId',a.id::text,
   'runPolicyRuleId',h.policy_rule_id::text,'earningPolicyRuleId',policy.id::text,'earningPolicyVersion',policy.version,'earningPolicy',policy.value)
 THEN RAISE EXCEPTION 'percentage earning must equal its complete exact original posting total and retained policy';END IF;
 IF EXISTS(SELECT 1 FROM app_employee_percentage_posting_witnesses(p_owner_kind,org_uuid,line_uuid) base JOIN posting p ON p.organization_id=base.organization_id AND p.id=base.posting_id
   JOIN posting original ON original.organization_id=p.organization_id AND original.transaction_id=p.transaction_id
   WHERE base.organization_id=org_uuid AND base.run_line_id=line_uuid AND base.is_earning_base
    AND NOT EXISTS(SELECT 1 FROM app_employee_percentage_posting_witnesses(p_owner_kind,org_uuid,line_uuid) kept WHERE kept.organization_id=org_uuid AND kept.run_line_id=line_uuid AND kept.posting_id=original.id))
  OR EXISTS(SELECT 1 FROM app_employee_percentage_posting_witnesses(p_owner_kind,org_uuid,line_uuid) kept JOIN posting p ON p.organization_id=kept.organization_id AND p.id=kept.posting_id
   WHERE kept.organization_id=org_uuid AND kept.run_line_id=line_uuid AND NOT EXISTS(
    SELECT 1 FROM app_employee_percentage_posting_witnesses(p_owner_kind,org_uuid,line_uuid) base JOIN posting source ON source.organization_id=base.organization_id AND source.id=base.posting_id
    WHERE base.organization_id=org_uuid AND base.run_line_id=line_uuid AND base.is_earning_base AND source.transaction_id=p.transaction_id))
 THEN RAISE EXCEPTION 'percentage history must retain every actual original journal posting and no unrelated authority sources';END IF;
END $function$;
CREATE OR REPLACE FUNCTION app_assert_employee_percentage_line(org_uuid uuid,line_uuid uuid) RETURNS void LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
 BEGIN PERFORM app_assert_employee_percentage_witnesses_for('RUN',org_uuid,line_uuid);END $$;
CREATE FUNCTION app_employee_percentage_request_witness_birth() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
 DECLARE s employee_earning_request_work%ROWTYPE;q employee_earning_run_request%ROWTYPE;slot jsonb;journal_uuid uuid;
 BEGIN
 SELECT * INTO s FROM employee_earning_request_work WHERE organization_id=NEW.organization_id AND id=NEW.source_id;
 SELECT * INTO q FROM employee_earning_run_request WHERE organization_id=NEW.organization_id AND id=s.request_id;
 IF s.id IS NULL OR q.id IS NULL OR q.earning_kind<>'PERCENTAGE' OR s.evidence_id IS NOT NULL OR s.decision_id IS NOT NULL
  OR NEW.position<0 OR NEW.position>=jsonb_array_length(s.source_snapshot->'witnesses')
  OR EXISTS(SELECT 1 FROM outbox_event WHERE organization_id=NEW.organization_id AND type='EmployeeEarningRunRequested' AND idempotency_key='employee-earning-run-request:'||q.id::text||':requested')
 THEN RAISE EXCEPTION 'percentage request witnesses require their original retained slot before the immutable worker receipt';END IF;
 SELECT transaction_id INTO journal_uuid FROM posting WHERE organization_id=NEW.organization_id AND id=NEW.posting_id;
 IF journal_uuid IS NULL THEN RAISE EXCEPTION 'percentage original journal is unavailable';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(NEW.organization_id::text||':journal-reversal:'||journal_uuid::text,0));
 slot=s.source_snapshot->'witnesses'->NEW.position;
 IF slot->>'postingId' IS DISTINCT FROM NEW.posting_id::text OR slot->>'compensationId' IS DISTINCT FROM NEW.compensation_id::text
  OR slot->>'configRuleId' IS DISTINCT FROM NEW.config_rule_id::text OR(slot->>'isEarningBase')::boolean IS DISTINCT FROM NEW.is_earning_base
 THEN RAISE EXCEPTION 'percentage request witness differs from its original retained slot';END IF;
 NEW.created_at=clock_timestamp();RETURN NEW;
 END $$;
CREATE TRIGGER employee_earning_percentage_witness_birth BEFORE INSERT ON employee_earning_request_percentage_witness FOR EACH ROW EXECUTE FUNCTION app_employee_percentage_request_witness_birth();
CREATE TRIGGER employee_earning_percentage_witness_immutable BEFORE UPDATE OR DELETE ON employee_earning_request_percentage_witness FOR EACH ROW EXECUTE FUNCTION app_operation_immutable();
ALTER TABLE employee_earning_request_percentage_witness ENABLE ROW LEVEL SECURITY;
ALTER TABLE employee_earning_request_percentage_witness FORCE ROW LEVEL SECURITY;
CREATE POLICY employee_earning_request_percentage_witness_tenant_isolation ON employee_earning_request_percentage_witness
 USING(organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid) WITH CHECK(organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid);
ALTER TABLE employee_earning_request_percentage_witness ADD CONSTRAINT employee_earning_percentage_position CHECK(position>=0 AND journal_amount>=0 AND journal_amount<>'NaN'::numeric);
ALTER TABLE employee_earning_request_work ADD CONSTRAINT employee_earning_work_evidence_pair CHECK((evidence_id IS NULL)=(decision_id IS NULL));
CREATE UNIQUE INDEX employee_earning_percentage_assignment_unique ON employee_earning_request_work(organization_id,request_id,assignment_id) WHERE evidence_id IS NULL AND decision_id IS NULL;

ALTER TABLE employee_earning_run_request DROP CONSTRAINT employee_earning_request_shape;
ALTER TABLE employee_earning_run_request ADD CONSTRAINT employee_earning_request_shape CHECK(((((((earning_kind)::text = 'PER_HOUR'::text) AND (request_fingerprint ~ '^[a-f0-9]{64}$'::text) AND (reviewed_source_fingerprint ~ '^[a-f0-9]{64}$'::text) AND isfinite(from_on) AND isfinite(to_on) AND (from_on <= to_on) AND (amount >= (0)::numeric) AND (amount <> 'NaN'::numeric) AND ((currency)::text ~ '^[A-Z]{3}$'::text) AND (jsonb_typeof(input) = 'object'::text) AND (jsonb_typeof(policy_snapshot) = 'object'::text) AND (jsonb_typeof(authorization_cap) = 'object'::text) AND ((authorization_cap ->> 'schemaVersion'::text) = '1'::text) AND ((authorization_cap ->> 'organizationId'::text) = (organization_id)::text) AND ((authorization_cap ->> 'userAccountId'::text) = (requested_by)::text) AND ((input ->> 'idempotencyKey'::text) = (idempotency_key)::text) AND ((input ->> 'fromOn'::text) = (from_on)::text) AND ((input ->> 'toOn'::text) = (to_on)::text) AND ((input ->> 'currency'::text) = (currency)::text) AND ((length(btrim((input ->> 'purpose'::text))) >= 3) AND (length(btrim((input ->> 'purpose'::text))) <= 1000)) AND ((length(btrim((input ->> 'reason'::text))) >= 6) AND (length(btrim((input ->> 'reason'::text))) <= 500)) AND (jsonb_typeof((input -> 'jobs'::text)) = 'array'::text) AND ((jsonb_array_length((input -> 'jobs'::text)) >= 1) AND (jsonb_array_length((input -> 'jobs'::text)) <= 10000)) AND ((((((((input - 'fromOn'::text) - 'toOn'::text) - 'currency'::text) - 'purpose'::text) - 'reason'::text) - 'idempotencyKey'::text) - 'jobs'::text) = '{}'::jsonb)) IS TRUE))) OR ((((((earning_kind)::text = 'PERCENTAGE'::text) AND (request_fingerprint ~ '^[a-f0-9]{64}$'::text) AND (reviewed_source_fingerprint ~ '^[a-f0-9]{64}$'::text) AND isfinite(from_on) AND isfinite(to_on) AND (from_on <= to_on) AND (amount >= (0)::numeric) AND (amount <> 'NaN'::numeric) AND ((currency)::text ~ '^[A-Z]{3}$'::text) AND (jsonb_typeof(input) = 'object'::text) AND (jsonb_typeof(policy_snapshot) = 'object'::text) AND (jsonb_typeof(authorization_cap) = 'object'::text) AND ((authorization_cap ->> 'schemaVersion'::text) = '1'::text) AND ((authorization_cap ->> 'organizationId'::text) = (organization_id)::text) AND ((authorization_cap ->> 'userAccountId'::text) = (requested_by)::text) AND ((input ->> 'idempotencyKey'::text) = (idempotency_key)::text) AND ((input ->> 'fromOn'::text) = (from_on)::text) AND ((input ->> 'toOn'::text) = (to_on)::text) AND ((input ->> 'currency'::text) = (currency)::text) AND ((length(btrim((input ->> 'purpose'::text))) >= 3) AND (length(btrim((input ->> 'purpose'::text))) <= 1000)) AND ((length(btrim((input ->> 'reason'::text))) >= 6) AND (length(btrim((input ->> 'reason'::text))) <= 500)) AND (jsonb_typeof((input -> 'bases'::text)) = 'array'::text) AND ((jsonb_array_length((input -> 'bases'::text)) >= 1) AND (jsonb_array_length((input -> 'bases'::text)) <= 10000)) AND ((((((((input - 'fromOn'::text) - 'toOn'::text) - 'currency'::text) - 'purpose'::text) - 'reason'::text) - 'idempotencyKey'::text) - 'bases'::text) = '{}'::jsonb)) IS TRUE))));
CREATE FUNCTION app_assert_employee_percentage_request(org_uuid uuid,request_uuid uuid) RETURNS void LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE q employee_earning_run_request%ROWTYPE;h employee_compensation_run%ROWTYPE;born xid;n integer;total numeric;s employee_earning_request_work%ROWTYPE;bases jsonb;
BEGIN
 SELECT * INTO q FROM employee_earning_run_request WHERE organization_id=org_uuid AND id=request_uuid;
 SELECT xmin INTO born FROM employee_earning_run_request WHERE organization_id=org_uuid AND id=request_uuid;
 IF q.id IS NULL OR q.earning_kind<>'PERCENTAGE' THEN RAISE EXCEPTION 'actual original percentage request required';END IF;
 h=jsonb_populate_record(NULL::employee_compensation_run,to_jsonb(q)||jsonb_build_object('created_at',q.requested_at,'created_by',q.requested_by,'purpose',q.input->>'purpose','reason',q.input->>'reason'));
 PERFORM app_assert_employee_percentage_header(h);
 SELECT count(*),sum(amount) INTO n,total FROM employee_earning_request_work WHERE organization_id=org_uuid AND request_id=request_uuid;
 IF n=0 OR q.amount IS DISTINCT FROM total
  OR EXISTS(SELECT 1 FROM employee_earning_request_work original_source WHERE original_source.organization_id=org_uuid AND original_source.request_id=request_uuid AND(original_source.xmin<>born OR original_source.created_at<q.requested_at OR original_source.currency<>q.currency OR original_source.evidence_id IS NOT NULL OR original_source.decision_id IS NOT NULL))
  OR(SELECT count(DISTINCT assignment_id) FROM employee_earning_request_work WHERE organization_id=org_uuid AND request_id=request_uuid)<>n
 THEN RAISE EXCEPTION 'percentage admission requires complete original same-birth source groups and exact reviewed Money';END IF;
 SELECT jsonb_agg(jsonb_build_object('postingId',w.posting_id::text,'assignmentId',original_source.assignment_id::text) ORDER BY w.posting_id::text,original_source.assignment_id::text) INTO bases
 FROM employee_earning_request_work original_source JOIN employee_earning_request_percentage_witness w ON w.organization_id=original_source.organization_id AND w.source_id=original_source.id
 WHERE original_source.organization_id=org_uuid AND original_source.request_id=request_uuid AND w.is_earning_base;
 IF bases IS NULL OR q.input->'bases' IS DISTINCT FROM bases
  OR EXISTS(SELECT 1 FROM employee_earning_request_work original_source JOIN employee_earning_request_percentage_witness w ON w.organization_id=original_source.organization_id AND w.source_id=original_source.id WHERE original_source.organization_id=org_uuid AND original_source.request_id=request_uuid AND w.is_earning_base GROUP BY original_source.person_id,w.posting_id HAVING count(*)>1)
 THEN RAISE EXCEPTION 'percentage admission must retain each exact selected original posting once for its actual beneficiary';END IF;
 FOR s IN SELECT * FROM employee_earning_request_work WHERE organization_id=org_uuid AND request_id=request_uuid ORDER BY id LOOP
  PERFORM app_assert_employee_percentage_witnesses_for('REQUEST',org_uuid,s.id);
 END LOOP;
 IF(SELECT count(*) FROM audit_log a WHERE a.organization_id=org_uuid AND a.resource_type='employee_earning_run_request' AND a.resource_id=q.id AND a.action='finance.employee_compensation.earning_run_requested')<>1
  OR NOT EXISTS(SELECT 1 FROM audit_log a WHERE a.organization_id=org_uuid AND a.resource_type='employee_earning_run_request' AND a.resource_id=q.id AND a.action='finance.employee_compensation.earning_run_requested' AND a.actor_id=q.requested_by AND a.reason=q.input->>'reason' AND a.after=jsonb_build_object('requestId',q.id::text) AND a.xmin=born)
  OR NOT EXISTS(SELECT 1 FROM outbox_event e WHERE e.organization_id=org_uuid AND e.type='EmployeeEarningRunRequested' AND e.idempotency_key='employee-earning-run-request:'||q.id::text||':requested' AND e.payload=jsonb_build_object('requestId',q.id::text) AND e.occurred_at=date_trunc('milliseconds',q.requested_at) AND e.xmin=born)
  OR NOT EXISTS(SELECT 1 FROM outbox_event e WHERE e.organization_id=org_uuid AND e.type='alvillas/outbox.dispatch.requested' AND e.idempotency_key='employee-earning-run:'||q.id::text||':dispatch' AND e.payload='{}'::jsonb AND e.xmin=born)
 THEN RAISE EXCEPTION 'earning admission requires its unique attributed atomic audit, original event and durable dispatch';END IF;
END $$;
CREATE OR REPLACE FUNCTION public.app_employee_earning_request_admission()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE h employee_compensation_run%ROWTYPE;
BEGIN
 IF NEW.earning_kind='PERCENTAGE' THEN
 NEW.requested_at=clock_timestamp();
 IF NOT EXISTS(SELECT 1 FROM user_account a JOIN person p ON p.organization_id=a.organization_id AND p.id=a.person_id WHERE a.organization_id=NEW.organization_id AND a.id=NEW.requested_by AND a.status='ACTIVE' AND p.archived_at IS NULL)
  OR NOT EXISTS(SELECT 1 FROM currency WHERE code=NEW.currency AND minor_unit<=2)
  OR EXISTS(SELECT 1 FROM employee_compensation_run WHERE organization_id=NEW.organization_id AND idempotency_key=NEW.idempotency_key)
 THEN RAISE EXCEPTION 'percentage admission requires its active actual actor, supported currency and unused run intent';END IF;
 h=jsonb_populate_record(NULL::employee_compensation_run,to_jsonb(NEW)||jsonb_build_object('created_at',NEW.requested_at,'created_by',NEW.requested_by));PERFORM app_assert_employee_percentage_header(h);RETURN NEW;END IF;
 NEW.requested_at=clock_timestamp();
 IF NOT EXISTS(SELECT 1 FROM user_account a JOIN person p ON p.organization_id=a.organization_id AND p.id=a.person_id WHERE a.organization_id=NEW.organization_id AND a.id=NEW.requested_by AND a.status='ACTIVE' AND p.archived_at IS NULL)
  OR NOT EXISTS(SELECT 1 FROM currency WHERE code=NEW.currency AND minor_unit<=2)
  OR EXISTS(SELECT 1 FROM employee_compensation_run WHERE organization_id=NEW.organization_id AND idempotency_key=NEW.idempotency_key)
 THEN RAISE EXCEPTION 'earning admission requires its active actual actor, supported currency and unused run intent';END IF;
 h=jsonb_populate_record(NULL::employee_compensation_run,to_jsonb(NEW)||jsonb_build_object('created_at',NEW.requested_at,'created_by',NEW.requested_by,'purpose',NEW.input->>'purpose','reason',NEW.input->>'reason'));
 PERFORM app_assert_employee_hourly_header(h);RETURN NEW;
END $function$;
CREATE OR REPLACE FUNCTION public.app_assert_employee_earning_request(org_uuid uuid, request_uuid uuid)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE q employee_earning_run_request%ROWTYPE;h employee_compensation_run%ROWTYPE;born xid;n integer;total numeric;line employee_earning_request_work%ROWTYPE;
BEGIN
 IF EXISTS(SELECT 1 FROM employee_earning_run_request WHERE organization_id=org_uuid AND id=request_uuid AND earning_kind='PERCENTAGE') THEN PERFORM app_assert_employee_percentage_request(org_uuid,request_uuid);RETURN;END IF;
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
END $function$;
CREATE FUNCTION app_assert_employee_percentage_request_source(org_uuid uuid,source_uuid uuid) RETURNS void LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
 DECLARE s employee_earning_request_work%ROWTYPE;q employee_earning_run_request%ROWTYPE;l employee_compensation_run_line%ROWTYPE;h employee_compensation_run%ROWTYPE;request_born xid;source_born xid;
 BEGIN
 SELECT * INTO s FROM employee_earning_request_work WHERE organization_id=org_uuid AND id=source_uuid;
 SELECT xmin INTO source_born FROM employee_earning_request_work WHERE organization_id=org_uuid AND id=source_uuid;
 SELECT * INTO q FROM employee_earning_run_request WHERE organization_id=org_uuid AND id=s.request_id;
 SELECT xmin INTO request_born FROM employee_earning_run_request WHERE organization_id=org_uuid AND id=s.request_id;
 IF s.id IS NULL OR q.id IS NULL OR q.earning_kind<>'PERCENTAGE' OR request_born IS DISTINCT FROM source_born OR s.created_at<q.requested_at OR s.currency<>q.currency OR s.evidence_id IS NOT NULL OR s.decision_id IS NOT NULL
  OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(q.input->'bases') base WHERE base->>'assignmentId'=s.assignment_id::text)
 THEN RAISE EXCEPTION 'percentage source must retain its original same-birth request and selected original assignment';END IF;
 l=jsonb_populate_record(NULL::employee_compensation_run_line,to_jsonb(s)||jsonb_build_object('run_id',s.request_id,'earning_kind','PERCENTAGE'));
 h=jsonb_populate_record(NULL::employee_compensation_run,to_jsonb(q)||jsonb_build_object('created_by',q.requested_by,'created_at',q.requested_at));PERFORM app_assert_employee_percentage_line_origin(l,h);
 END $$;
CREATE OR REPLACE FUNCTION public.app_employee_earning_request_complete()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE q employee_earning_run_request%ROWTYPE;s employee_earning_request_work%ROWTYPE;request_born xid;source_born xid;witness_born xid;task_uuid uuid;n integer;slot jsonb;
BEGIN
 IF TG_TABLE_NAME='employee_earning_request_work' THEN
 IF EXISTS(SELECT 1 FROM employee_earning_run_request WHERE organization_id=NEW.organization_id AND id=NEW.request_id AND earning_kind='PERCENTAGE') THEN PERFORM app_assert_employee_percentage_request_source(NEW.organization_id,NEW.id);RETURN NULL;END IF;
 END IF;
 IF TG_TABLE_NAME='employee_earning_run_request' THEN PERFORM app_assert_employee_earning_request(NEW.organization_id,NEW.id);RETURN NULL;END IF;
 IF TG_TABLE_NAME='employee_earning_request_work' THEN SELECT * INTO s FROM employee_earning_request_work WHERE organization_id=NEW.organization_id AND id=NEW.id;
 ELSE SELECT * INTO s FROM employee_earning_request_work WHERE organization_id=NEW.organization_id AND id=NEW.source_id;END IF;
 SELECT * INTO q FROM employee_earning_run_request WHERE organization_id=NEW.organization_id AND id=s.request_id;
 SELECT xmin INTO request_born FROM employee_earning_run_request WHERE organization_id=NEW.organization_id AND id=q.id;
 SELECT xmin INTO source_born FROM employee_earning_request_work WHERE organization_id=NEW.organization_id AND id=s.id;
 SELECT task_id INTO task_uuid FROM employee_work_time_evidence WHERE organization_id=NEW.organization_id AND id=s.evidence_id;
 IF q.id IS NULL OR s.id IS NULL OR request_born IS DISTINCT FROM source_born OR s.created_at<q.requested_at OR s.currency IS DISTINCT FROM q.currency
  OR NOT(q.input->'jobs' @>jsonb_build_array(jsonb_build_object('taskId',task_uuid::text,'assignmentId',s.assignment_id::text,'evidenceId',s.evidence_id::text,'decisionId',s.decision_id::text,'confirmedAssignment',true)))
 THEN RAISE EXCEPTION 'earning source must retain its original same-birth request and selected actual work';END IF;
 IF TG_TABLE_NAME='employee_earning_request_hourly_witness' THEN
  SELECT xmin INTO witness_born FROM employee_earning_request_hourly_witness WHERE organization_id=NEW.organization_id AND id=NEW.id;
  SELECT count(*) INTO n FROM employee_earning_request_hourly_witness WHERE organization_id=NEW.organization_id AND source_id=s.id;
  slot=s.source_snapshot->'witnesses'->NEW.position;
  IF witness_born IS DISTINCT FROM source_born OR n>jsonb_array_length(s.source_snapshot->'witnesses') OR slot IS NULL
   OR slot->>'intervalId' IS DISTINCT FROM NEW.interval_id::text OR slot->>'compensationId' IS DISTINCT FROM NEW.compensation_id::text OR slot->>'configRuleId' IS DISTINCT FROM NEW.config_rule_id::text
   OR slot->>'startsAt' IS DISTINCT FROM to_char(NEW.starts_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') OR slot->>'endsAt' IS DISTINCT FROM to_char(NEW.ends_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  THEN RAISE EXCEPTION 'earning witness must retain its exact original same-birth reviewed interval slot';END IF;
 END IF;RETURN NULL;
END $function$;
CREATE OR REPLACE FUNCTION public.app_employee_earning_outcome_complete()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
   OR EXISTS(SELECT 1 FROM employee_earning_request_work s WHERE s.organization_id=NEW.organization_id AND s.request_id=q.id AND NOT EXISTS(SELECT 1 FROM employee_compensation_run_line l WHERE l.organization_id=s.organization_id AND l.run_id=r.id AND l.person_id=s.person_id AND l.assignment_id=s.assignment_id AND l.compensation_id=s.compensation_id AND l.config_rule_id=s.config_rule_id AND l.work_time_evidence_id IS NOT DISTINCT FROM s.evidence_id AND l.work_time_decision_id IS NOT DISTINCT FROM s.decision_id AND l.recorded_completion_at=s.recorded_completion_at AND l.rate=s.rate AND l.amount=s.amount AND l.currency=s.currency AND l.source_snapshot=s.source_snapshot AND(q.earning_kind<>'PERCENTAGE' OR ROW(l.property_id,l.task_id,l.source_city_id,l.source_region_id) IS NOT DISTINCT FROM ROW(s.property_id,s.task_id,s.source_city_id,s.source_region_id))))
  THEN RAISE EXCEPTION 'successful earning outcome must bind the exact original reviewed same-birth financial run';END IF;
 ELSIF EXISTS(SELECT 1 FROM employee_compensation_run created_run WHERE created_run.organization_id=NEW.organization_id AND created_run.idempotency_key=q.idempotency_key AND created_run.xmin=born) THEN
  RAISE EXCEPTION 'failed earning outcomes cannot create an associated financial run';
 END IF;
 IF(SELECT count(*) FROM audit_log a WHERE a.organization_id=NEW.organization_id AND a.resource_type='employee_earning_run_request' AND a.resource_id=q.id AND a.action='finance.employee_compensation.earning_run_completed')<>1
  OR NOT EXISTS(SELECT 1 FROM audit_log a WHERE a.organization_id=NEW.organization_id AND a.resource_type='employee_earning_run_request' AND a.resource_id=q.id AND a.action='finance.employee_compensation.earning_run_completed' AND a.actor_id=q.requested_by AND a.reason=q.input->>'reason' AND a.xmin=born AND a.after=jsonb_build_object('requestId',q.id::text,'outcomeId',NEW.id::text,'state',NEW.state,'runId',NEW.run_id::text,'failureCode',NEW.failure_code))
 THEN RAISE EXCEPTION 'earning outcome requires its unique attributed atomic completion audit';END IF;RETURN NULL;
END $function$;
CREATE OR REPLACE FUNCTION public.app_guard_employee_hourly_assignment_identity()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
 IF ROW(NEW.id,NEW.organization_id,NEW.person_id,NEW.role_id,NEW.scope_type,NEW.scope_id,NEW.valid_from) IS DISTINCT FROM ROW(OLD.id,OLD.organization_id,OLD.person_id,OLD.role_id,OLD.scope_type,OLD.scope_id,OLD.valid_from)
  AND EXISTS(SELECT 1 FROM employee_earning_request_percentage_witness w JOIN team_compensation c ON c.organization_id=w.organization_id AND c.id=w.compensation_id WHERE c.organization_id=OLD.organization_id AND c.assignment_id=OLD.id)
 THEN RAISE EXCEPTION 'Original percentage request assignment identity is immutable; retire it and append a replacement' USING ERRCODE='23514';END IF;
 IF ROW(NEW.id,NEW.organization_id,NEW.person_id,NEW.role_id,NEW.scope_type,NEW.scope_id,NEW.valid_from) IS DISTINCT FROM ROW(OLD.id,OLD.organization_id,OLD.person_id,OLD.role_id,OLD.scope_type,OLD.scope_id,OLD.valid_from) AND EXISTS(SELECT 1 FROM employee_compensation_percentage_witness w JOIN team_compensation c ON c.organization_id=w.organization_id AND c.id=w.compensation_id WHERE c.organization_id=OLD.organization_id AND c.assignment_id=OLD.id) THEN RAISE EXCEPTION 'Original percentage earning assignment identity is immutable; retire it and append a replacement' USING ERRCODE='23514';END IF;
 IF ROW(NEW.id,NEW.organization_id,NEW.person_id,NEW.role_id,NEW.scope_type,NEW.scope_id,NEW.valid_from) IS DISTINCT FROM ROW(OLD.id,OLD.organization_id,OLD.person_id,OLD.role_id,OLD.scope_type,OLD.scope_id,OLD.valid_from)
  AND(EXISTS(SELECT 1 FROM employee_compensation_hourly_witness w JOIN team_compensation c ON c.organization_id=w.organization_id AND c.id=w.compensation_id WHERE c.organization_id=OLD.organization_id AND c.assignment_id=OLD.id)
   OR EXISTS(SELECT 1 FROM employee_earning_request_hourly_witness w JOIN team_compensation c ON c.organization_id=w.organization_id AND c.id=w.compensation_id WHERE c.organization_id=OLD.organization_id AND c.assignment_id=OLD.id))
 THEN RAISE EXCEPTION 'Original hourly earning assignment identity is immutable; retire it and append a replacement' USING ERRCODE='23514';END IF;RETURN NEW;
END $function$;

COMMIT;
