BEGIN;
-- CreateTable
CREATE TABLE "employee_compensation_percentage_witness" (
    "id" UUID NOT NULL DEFAULT app_uuid_v7(),
    "organization_id" UUID NOT NULL,
    "run_line_id" UUID NOT NULL,
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

    CONSTRAINT "employee_compensation_percentage_witness_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "employee_percentage_posting_idx" ON "employee_compensation_percentage_witness"("organization_id", "posting_id", "run_line_id");

-- CreateIndex
CREATE INDEX "employee_percentage_contract_idx" ON "employee_compensation_percentage_witness"("organization_id", "compensation_id");

-- CreateIndex
CREATE INDEX "employee_percentage_policy_idx" ON "employee_compensation_percentage_witness"("organization_id", "policy_rule_id");

-- CreateIndex
CREATE UNIQUE INDEX "employee_percentage_org_id_unique" ON "employee_compensation_percentage_witness"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "employee_percentage_position_unique" ON "employee_compensation_percentage_witness"("organization_id", "run_line_id", "position");

-- CreateIndex
CREATE UNIQUE INDEX "employee_percentage_line_posting_unique" ON "employee_compensation_percentage_witness"("organization_id", "run_line_id", "posting_id");

-- CreateIndex
CREATE UNIQUE INDEX "posting_org_id_unique" ON "posting"("organization_id", "id");

-- AddForeignKey
ALTER TABLE "employee_compensation_percentage_witness" ADD CONSTRAINT "employee_compensation_percentage_witness_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "employee_compensation_percentage_witness" ADD CONSTRAINT "employee_percentage_line_fk" FOREIGN KEY ("organization_id", "run_line_id") REFERENCES "employee_compensation_run_line"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "employee_compensation_percentage_witness" ADD CONSTRAINT "employee_percentage_posting_fk" FOREIGN KEY ("organization_id", "posting_id") REFERENCES "posting"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "employee_compensation_percentage_witness" ADD CONSTRAINT "employee_percentage_contract_fk" FOREIGN KEY ("organization_id", "compensation_id") REFERENCES "team_compensation"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "employee_compensation_percentage_witness" ADD CONSTRAINT "employee_percentage_rate_rule_fk" FOREIGN KEY ("organization_id", "config_rule_id") REFERENCES "config_rule"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "employee_compensation_percentage_witness" ADD CONSTRAINT "employee_percentage_policy_fk" FOREIGN KEY ("organization_id", "policy_rule_id") REFERENCES "config_rule"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "employee_compensation_percentage_witness" ADD CONSTRAINT "employee_percentage_property_fk" FOREIGN KEY ("organization_id", "property_id") REFERENCES "property"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "employee_compensation_percentage_witness" ADD CONSTRAINT "employee_percentage_city_fk" FOREIGN KEY ("organization_id", "source_city_id") REFERENCES "city"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "employee_compensation_percentage_witness" ADD CONSTRAINT "employee_percentage_region_fk" FOREIGN KEY ("organization_id", "source_region_id") REFERENCES "region"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "employee_compensation_percentage_witness" ADD CONSTRAINT "employee_percentage_reservation_fk" FOREIGN KEY ("organization_id", "reservation_id") REFERENCES "reservation"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "employee_compensation_percentage_witness" ADD CONSTRAINT "employee_percentage_task_fk" FOREIGN KEY ("organization_id", "task_id") REFERENCES "operation_task"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "employee_compensation_percentage_witness" ADD CONSTRAINT "employee_percentage_owner_fk" FOREIGN KEY ("organization_id", "owner_id") REFERENCES "owner"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;


ALTER TABLE employee_compensation_percentage_witness ADD CONSTRAINT employee_percentage_position CHECK(position>=0 AND journal_amount>=0 AND journal_amount<>'NaN'::numeric);
ALTER TABLE employee_compensation_percentage_witness ENABLE ROW LEVEL SECURITY;
ALTER TABLE employee_compensation_percentage_witness FORCE ROW LEVEL SECURITY;
CREATE POLICY employee_percentage_tenant_isolation ON employee_compensation_percentage_witness
 USING(organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid)
 WITH CHECK(organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid);
CREATE TRIGGER employee_percentage_immutable BEFORE UPDATE OR DELETE ON employee_compensation_percentage_witness
 FOR EACH ROW EXECUTE FUNCTION app_operation_immutable();

CREATE FUNCTION app_assert_employee_percentage_line_header(l employee_compensation_run_line) RETURNS void LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE h employee_compensation_run%ROWTYPE;a role_assignment%ROWTYPE;j operation_task%ROWTYPE;
BEGIN
 SELECT * INTO h FROM employee_compensation_run WHERE organization_id=l.organization_id AND id=l.run_id;
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
END $$;

CREATE FUNCTION app_assert_employee_percentage_header(h employee_compensation_run) RETURNS void
 LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE p config_rule%ROWTYPE;selected uuid;
BEGIN
 SELECT * INTO p FROM config_rule WHERE organization_id=h.organization_id AND id=h.policy_rule_id;
 SELECT id INTO selected FROM config_rule WHERE organization_id=h.organization_id AND key='staff.compensation_percentage_runs'
  AND scope_type='organization' AND scope_id IS NULL AND archived_at IS NULL AND lifecycle IN('ACTIVE','RETIRED')
  AND effective_from<=h.created_at AND(effective_to IS NULL OR effective_to>h.created_at) ORDER BY effective_from DESC,version DESC LIMIT 1;
 IF h.earning_kind<>'PERCENTAGE' OR p.id IS NULL OR p.id IS DISTINCT FROM selected OR p.scope_type<>'organization' OR p.scope_id IS NOT NULL
  OR p.key<>'staff.compensation_percentage_runs' OR p.value->>'earning_date' IS DISTINCT FROM 'ACTUAL_POSTED_FINANCIAL_BASE'
  OR p.value->>'earning_unit' IS DISTINCT FROM 'PERSON_ASSIGNMENT_SELECTED_POSTINGS' OR p.value->>'timezone' IS DISTINCT FROM h.timezone
  OR NOT EXISTS(SELECT 1 FROM pg_timezone_names WHERE name=h.timezone) OR NOT isfinite(h.from_on) OR NOT isfinite(h.to_on) OR h.from_on>h.to_on
  OR jsonb_typeof(p.value->'max_period_days') IS DISTINCT FROM 'number' OR (p.value->>'max_period_days')::numeric<=0
  OR (p.value->>'max_period_days')::numeric>2147483647 OR (p.value->>'max_period_days')::numeric<>trunc((p.value->>'max_period_days')::numeric)
  OR h.to_on-h.from_on+1>(p.value->>'max_period_days')::numeric
  OR(p.value-'earning_date'-'earning_unit'-'timezone'-'max_period_days')<>'{}'::jsonb
  OR h.policy_snapshot IS DISTINCT FROM jsonb_build_object('schemaVersion',1,'policyRuleId',p.id::text,'policyVersion',p.version,'value',p.value)
 THEN RAISE EXCEPTION 'percentage run requires its actual configured posted-source earning unit and calendar';END IF;
END $$;

CREATE FUNCTION app_employee_percentage_witness_birth() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE l employee_compensation_run_line%ROWTYPE;slot jsonb;journal_uuid uuid;
BEGIN
 SELECT * INTO l FROM employee_compensation_run_line WHERE organization_id=NEW.organization_id AND id=NEW.run_line_id;
 IF l.id IS NULL OR l.earning_kind<>'PERCENTAGE'
  OR NEW.position<0 OR NEW.position>=jsonb_array_length(l.source_snapshot->'witnesses')
 THEN RAISE EXCEPTION 'percentage witnesses require their actual same-birth source line and immutable slot';END IF;
 SELECT transaction_id INTO journal_uuid FROM posting WHERE organization_id=NEW.organization_id AND id=NEW.posting_id;
 IF journal_uuid IS NULL THEN RAISE EXCEPTION 'percentage original journal is unavailable';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(NEW.organization_id::text||':journal-reversal:'||journal_uuid::text,0));
 slot=l.source_snapshot->'witnesses'->NEW.position;
 IF slot->>'postingId' IS DISTINCT FROM NEW.posting_id::text OR slot->>'compensationId' IS DISTINCT FROM NEW.compensation_id::text
  OR slot->>'configRuleId' IS DISTINCT FROM NEW.config_rule_id::text OR(slot->>'isEarningBase')::boolean IS DISTINCT FROM NEW.is_earning_base
 THEN RAISE EXCEPTION 'percentage witness differs from its original retained slot';END IF;
 NEW.created_at=clock_timestamp();RETURN NEW;
END $$;
CREATE TRIGGER employee_percentage_witness_birth BEFORE INSERT ON employee_compensation_percentage_witness
 FOR EACH ROW EXECUTE FUNCTION app_employee_percentage_witness_birth();

CREATE FUNCTION app_assert_employee_percentage_line(org_uuid uuid,line_uuid uuid) RETURNS void
 LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE l employee_compensation_run_line%ROWTYPE;h employee_compensation_run%ROWTYPE;a role_assignment%ROWTYPE;subject person%ROWTYPE;
 policy config_rule%ROWTYPE;selected uuid;selected_rule uuid;born xid;w record;slot jsonb;refs jsonb;expected jsonb;
 task_row operation_task%ROWTYPE;reservation_row reservation%ROWTYPE;property_row property%ROWTYPE;
 task_uuid uuid;reservation_uuid uuid;property_uuid uuid;owner_uuid uuid;total numeric:=0;last_at timestamptz;
 n integer;base_count integer;first_base record;has_base boolean:=false;seen_count integer:=0;
BEGIN
 SELECT * INTO l FROM employee_compensation_run_line WHERE organization_id=org_uuid AND id=line_uuid;
 SELECT xmin INTO born FROM employee_compensation_run_line WHERE organization_id=org_uuid AND id=line_uuid;
 SELECT * INTO h FROM employee_compensation_run WHERE organization_id=org_uuid AND id=l.run_id;
 SELECT * INTO a FROM role_assignment WHERE organization_id=org_uuid AND id=l.assignment_id;
 SELECT * INTO subject FROM person WHERE organization_id=org_uuid AND id=l.person_id;
 IF l.id IS NULL OR h.id IS NULL OR a.id IS NULL OR subject.id IS NULL OR l.earning_kind<>'PERCENTAGE' OR h.earning_kind<>'PERCENTAGE'
  OR a.person_id<>l.person_id OR l.currency<>h.currency THEN RAISE EXCEPTION 'percentage source line requires its actual tenant header and beneficiary assignment';END IF;
 SELECT count(*),count(*) FILTER(WHERE is_earning_base) INTO n,base_count FROM employee_compensation_percentage_witness WHERE organization_id=org_uuid AND run_line_id=line_uuid;
 IF n=0 OR base_count=0 OR n<>jsonb_array_length(l.source_snapshot->'witnesses')
  OR EXISTS(SELECT 1 FROM employee_compensation_percentage_witness WHERE organization_id=org_uuid AND run_line_id=line_uuid AND(xmin<>born OR position>=n))
 THEN RAISE EXCEPTION 'percentage source requires every original same-birth posting witness';END IF;
 SELECT p.* INTO policy FROM config_rule p JOIN employee_compensation_percentage_witness policy_witness ON policy_witness.organization_id=p.organization_id AND policy_witness.policy_rule_id=p.id
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
  FROM employee_compensation_percentage_witness x JOIN posting p ON p.organization_id=x.organization_id AND p.id=x.posting_id
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
 IF EXISTS(SELECT 1 FROM employee_compensation_percentage_witness base JOIN posting p ON p.organization_id=base.organization_id AND p.id=base.posting_id
   JOIN posting original ON original.organization_id=p.organization_id AND original.transaction_id=p.transaction_id
   WHERE base.organization_id=org_uuid AND base.run_line_id=line_uuid AND base.is_earning_base
    AND NOT EXISTS(SELECT 1 FROM employee_compensation_percentage_witness kept WHERE kept.organization_id=org_uuid AND kept.run_line_id=line_uuid AND kept.posting_id=original.id))
  OR EXISTS(SELECT 1 FROM employee_compensation_percentage_witness kept JOIN posting p ON p.organization_id=kept.organization_id AND p.id=kept.posting_id
   WHERE kept.organization_id=org_uuid AND kept.run_line_id=line_uuid AND NOT EXISTS(
    SELECT 1 FROM employee_compensation_percentage_witness base JOIN posting source ON source.organization_id=base.organization_id AND source.id=base.posting_id
    WHERE base.organization_id=org_uuid AND base.run_line_id=line_uuid AND base.is_earning_base AND source.transaction_id=p.transaction_id))
 THEN RAISE EXCEPTION 'percentage history must retain every actual original journal posting and no unrelated authority sources';END IF;
END $$;

CREATE FUNCTION app_assert_employee_percentage_run(h employee_compensation_run) RETURNS void LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE born xid;n integer;total numeric;l employee_compensation_run_line%ROWTYPE;
BEGIN
 PERFORM app_assert_employee_percentage_header(h);
 SELECT xmin INTO born FROM employee_compensation_run WHERE organization_id=h.organization_id AND id=h.id;
 SELECT count(*),sum(amount) INTO n,total FROM employee_compensation_run_line WHERE organization_id=h.organization_id AND run_id=h.id;
 IF n=0 OR EXISTS(SELECT 1 FROM employee_compensation_run_line WHERE organization_id=h.organization_id AND run_id=h.id AND(earning_kind<>'PERCENTAGE' OR xmin<>born))
  OR(SELECT count(*) FROM audit_log WHERE organization_id=h.organization_id AND resource_type='employee_compensation_run' AND resource_id=h.id AND action='finance.employee_compensation_run.created')<>1
  OR NOT EXISTS(SELECT 1 FROM audit_log WHERE organization_id=h.organization_id AND resource_type='employee_compensation_run' AND resource_id=h.id AND action='finance.employee_compensation_run.created'
   AND xmin=born AND actor_id=h.created_by AND reason=h.reason AND after=jsonb_build_object('runId',h.id::text,'kind','PERCENTAGE_POSTED_DRAFT','lineCount',n,'total',jsonb_build_object('amount',total::numeric(128,2)::text,'currency',h.currency)))
  OR NOT EXISTS(SELECT 1 FROM outbox_event WHERE organization_id=h.organization_id AND type='EmployeeCompensationRunCreated' AND xmin=born
   AND idempotency_key='employee-compensation-run:'||h.id::text||':created' AND payload=jsonb_build_object('runId',h.id::text))
 THEN RAISE EXCEPTION 'percentage run requires complete same-birth sources and its attributed atomic audit and outbox receipt';END IF;
 IF EXISTS(SELECT 1 FROM employee_compensation_percentage_witness w JOIN employee_compensation_run_line source_line ON source_line.organization_id=w.organization_id AND source_line.id=w.run_line_id
  WHERE source_line.organization_id=h.organization_id AND source_line.run_id=h.id AND w.is_earning_base GROUP BY source_line.person_id,w.posting_id HAVING count(*)<>1)
 THEN RAISE EXCEPTION 'an actual financial posting can earn once per beneficiary in a percentage run';END IF;
 IF EXISTS(SELECT 1 FROM employee_compensation_run_line WHERE organization_id=h.organization_id AND run_id=h.id GROUP BY assignment_id HAVING count(*)<>1)
 THEN RAISE EXCEPTION 'percentage earnings round once per original assignment and selected posting set';END IF;
 FOR l IN SELECT * FROM employee_compensation_run_line WHERE organization_id=h.organization_id AND run_id=h.id LOOP PERFORM app_assert_employee_percentage_line(l.organization_id,l.id);END LOOP;
END $$;

ALTER TABLE employee_compensation_run DROP CONSTRAINT employee_run_earning_kind;
ALTER TABLE employee_compensation_run ADD CONSTRAINT employee_run_earning_kind CHECK(earning_kind IN('PER_JOB','PER_MONTH','PER_HOUR','PERCENTAGE'));
ALTER TABLE employee_compensation_run_line DROP CONSTRAINT employee_compensation_run_line_fields;
ALTER TABLE employee_compensation_run_line ADD CONSTRAINT employee_compensation_run_line_fields CHECK((((rate >= (0)::numeric) AND (amount >= (0)::numeric) AND (rate <> 'NaN'::numeric) AND (amount <> 'NaN'::numeric) AND ((((earning_kind)::text = 'PER_JOB'::text) AND (rate = amount) AND (task_id IS NOT NULL) AND (completion_event_id IS NOT NULL) AND (property_id IS NOT NULL) AND (earning_period_key IS NULL) AND (source_city_id IS NULL) AND (source_region_id IS NULL) AND (work_time_evidence_id IS NULL) AND (work_time_decision_id IS NULL)) OR (((earning_kind)::text = 'PER_MONTH'::text) AND (completion_event_id IS NULL) AND ((earning_period_key)::text ~ '^\d{4}-(0[1-9]|1[0-2])$'::text) AND (work_time_evidence_id IS NULL) AND (work_time_decision_id IS NULL)) OR (((earning_kind)::text = 'PER_HOUR'::text) AND (task_id IS NOT NULL) AND (completion_event_id IS NOT NULL) AND (property_id IS NOT NULL) AND (earning_period_key IS NULL) AND (source_city_id IS NULL) AND (source_region_id IS NULL) AND (work_time_evidence_id IS NOT NULL) AND (work_time_decision_id IS NOT NULL))))) OR (earning_kind='PERCENTAGE' AND rate>=0 AND rate<=100 AND rate<>'NaN'::numeric AND amount>=0 AND amount<>'NaN'::numeric AND completion_event_id IS NULL AND earning_period_key IS NULL AND work_time_evidence_id IS NULL AND work_time_decision_id IS NULL));
CREATE OR REPLACE FUNCTION public.app_employee_compensation_run_admission()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE policy config_rule%ROWTYPE; point timestamptz;
BEGIN
 IF NEW.earning_kind='PERCENTAGE' THEN NEW.created_at=clock_timestamp();PERFORM app_assert_employee_percentage_header(NEW);RETURN NEW;END IF;

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
 IF NEW.earning_kind='PERCENTAGE' THEN PERFORM app_assert_employee_percentage_line_header(NEW);NEW.created_at=clock_timestamp();RETURN NEW;END IF;
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
 IF TG_TABLE_NAME='employee_compensation_run' AND NEW.earning_kind='PERCENTAGE' THEN PERFORM app_assert_employee_percentage_run(NEW);RETURN NEW;END IF;
 IF TG_TABLE_NAME='employee_compensation_run_line' AND NEW.earning_kind='PERCENTAGE' THEN PERFORM app_assert_employee_percentage_line(NEW.organization_id,NEW.id);RETURN NEW;END IF;
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
 IF EXISTS(SELECT 1 FROM employee_compensation_run_line WHERE organization_id=NEW.organization_id AND id=NEW.run_line_id AND earning_kind='PERCENTAGE') THEN RAISE EXCEPTION 'Percentage financial submission requires typed source-claim admission';END IF;
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
CREATE OR REPLACE FUNCTION public.app_guard_employee_hourly_assignment_identity()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
 IF ROW(NEW.id,NEW.organization_id,NEW.person_id,NEW.role_id,NEW.scope_type,NEW.scope_id,NEW.valid_from) IS DISTINCT FROM ROW(OLD.id,OLD.organization_id,OLD.person_id,OLD.role_id,OLD.scope_type,OLD.scope_id,OLD.valid_from) AND EXISTS(SELECT 1 FROM employee_compensation_percentage_witness w JOIN team_compensation c ON c.organization_id=w.organization_id AND c.id=w.compensation_id WHERE c.organization_id=OLD.organization_id AND c.assignment_id=OLD.id) THEN RAISE EXCEPTION 'Original percentage earning assignment identity is immutable; retire it and append a replacement' USING ERRCODE='23514';END IF;
 IF ROW(NEW.id,NEW.organization_id,NEW.person_id,NEW.role_id,NEW.scope_type,NEW.scope_id,NEW.valid_from) IS DISTINCT FROM ROW(OLD.id,OLD.organization_id,OLD.person_id,OLD.role_id,OLD.scope_type,OLD.scope_id,OLD.valid_from)
  AND(EXISTS(SELECT 1 FROM employee_compensation_hourly_witness w JOIN team_compensation c ON c.organization_id=w.organization_id AND c.id=w.compensation_id WHERE c.organization_id=OLD.organization_id AND c.assignment_id=OLD.id)
   OR EXISTS(SELECT 1 FROM employee_earning_request_hourly_witness w JOIN team_compensation c ON c.organization_id=w.organization_id AND c.id=w.compensation_id WHERE c.organization_id=OLD.organization_id AND c.assignment_id=OLD.id))
 THEN RAISE EXCEPTION 'Original hourly earning assignment identity is immutable; retire it and append a replacement' USING ERRCODE='23514';END IF;RETURN NEW;
END $function$;
COMMIT;
