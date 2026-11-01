BEGIN;
CREATE OR REPLACE FUNCTION public.app_assert_employee_percentage_witnesses_for(p_owner_kind text, org_uuid uuid, line_uuid uuid)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
 SET plan_cache_mode TO 'force_custom_plan'
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
 SELECT projected.* INTO l FROM employee_earning_request_work s
 CROSS JOIN LATERAL jsonb_populate_record(NULL::employee_compensation_run_line,to_jsonb(s)||jsonb_build_object('run_id',s.request_id,'earning_kind','PERCENTAGE')) AS projected
 WHERE s.organization_id=org_uuid AND s.id=line_uuid AND s.evidence_id IS NULL AND s.decision_id IS NULL;
 SELECT xmin INTO born FROM employee_earning_request_work WHERE organization_id=org_uuid AND id=line_uuid;
 SELECT projected.* INTO h FROM employee_earning_run_request q
 CROSS JOIN LATERAL jsonb_populate_record(NULL::employee_compensation_run,to_jsonb(q)||jsonb_build_object('created_by',q.requested_by,'created_at',q.requested_at)) AS projected
 WHERE q.organization_id=org_uuid AND q.id=l.run_id;
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
 FOR w IN WITH selected_postings AS MATERIALIZED(
   SELECT x.*,p.transaction_id,p.ledger_account_id,p.side,p.amount posting_amount,p.currency posting_currency,p.bucket,p.dimensions
   FROM app_employee_percentage_posting_witnesses(p_owner_kind,org_uuid,line_uuid) x
   JOIN posting p ON p.organization_id=x.organization_id AND p.id=x.posting_id
   WHERE x.organization_id=org_uuid AND x.run_line_id=line_uuid
  ),original_journals AS MATERIALIZED(
   SELECT x.*,t.occurred_at,t.sealed,t.reverses_transaction_id FROM selected_postings x
   JOIN financial_transaction t ON t.organization_id=x.organization_id AND t.id=x.transaction_id
  )
  SELECT x.*,c.assignment_id,c.config_rule_id original_rule,c.mode,c.amount rate_amount,c.currency rate_currency,c.version compensation_version,c.effective_from,
  r.version config_version,r.key rule_key,r.scope_type,r.scope_id,r.value,r.effective_from rule_from,r.effective_to rule_to,r.archived_at rule_archived,r.lifecycle rule_lifecycle,
  selected_rate.id selected_compensation_id,selected_config.id selected_config_rule_id
  FROM original_journals x
  JOIN ledger_account k ON k.organization_id=x.organization_id AND k.id=x.ledger_account_id
  JOIN team_compensation c ON c.organization_id=x.organization_id AND c.id=x.compensation_id
  JOIN config_rule r ON r.organization_id=x.organization_id AND r.id=x.config_rule_id
  LEFT JOIN LATERAL(SELECT id FROM team_compensation WHERE organization_id=org_uuid AND assignment_id=a.id AND effective_from<=x.occurred_at ORDER BY version DESC LIMIT 1) selected_rate ON true
  LEFT JOIN LATERAL(SELECT id FROM config_rule WHERE organization_id=org_uuid AND key='staff.compensation' AND scope_type='role_assignment' AND scope_id=a.id
   AND archived_at IS NULL AND lifecycle IN('ACTIVE','RETIRED') AND effective_from<=x.occurred_at AND(effective_to IS NULL OR effective_to>x.occurred_at) ORDER BY effective_from DESC,version DESC LIMIT 1) selected_config ON true
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
  IF w.compensation_id IS DISTINCT FROM w.selected_compensation_id OR w.config_rule_id IS DISTINCT FROM w.selected_config_rule_id THEN RAISE EXCEPTION 'percentage witness must retain the actual original rate and configuration';END IF;
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
COMMIT;
