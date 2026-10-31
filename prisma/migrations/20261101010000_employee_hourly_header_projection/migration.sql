-- Preserve every actual typed header value without converting discarded intent and authorization JSON.
BEGIN;
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
 SELECT mapped.* INTO l
 FROM employee_earning_request_work s JOIN employee_work_time_evidence e ON e.organization_id=s.organization_id AND e.id=s.evidence_id
 CROSS JOIN LATERAL jsonb_populate_record(NULL::employee_compensation_run_line,to_jsonb(s)||jsonb_build_object('run_id',s.request_id,'earning_kind','PER_HOUR','task_id',e.task_id,'property_id',e.property_id,'completion_event_id',e.completion_event_id,'work_time_evidence_id',s.evidence_id,'work_time_decision_id',s.decision_id)) AS mapped WHERE s.organization_id=org_uuid AND s.id=line_uuid;
 IF l.id IS NULL THEN RAISE EXCEPTION 'hourly admission requires its actual retained work source';END IF;
 SELECT mapped.* INTO h
 FROM employee_earning_run_request r
 CROSS JOIN LATERAL jsonb_populate_record(NULL::employee_compensation_run,jsonb_build_object('id',r.id,'organization_id',r.organization_id,'idempotency_key',r.idempotency_key,'request_fingerprint',r.request_fingerprint,'from_on',r.from_on,'to_on',r.to_on,'timezone',r.timezone,'currency',r.currency,'policy_rule_id',r.policy_rule_id,'policy_snapshot',r.policy_snapshot,'earning_kind',r.earning_kind)||jsonb_build_object('created_by',r.requested_by,'created_at',r.requested_at)) AS mapped WHERE r.organization_id=org_uuid AND r.id=l.run_id;
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
COMMIT;
