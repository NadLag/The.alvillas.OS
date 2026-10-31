BEGIN;

CREATE FUNCTION app_compensation_creation_request_nonce() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended(NEW.organization_id::text||':employee-compensation-run-key:'||NEW.idempotency_key::text,0));
 IF EXISTS(SELECT 1 FROM employee_compensation_run WHERE organization_id=NEW.organization_id AND idempotency_key=NEW.idempotency_key)
  OR TG_TABLE_NAME='employee_earning_run_request' AND EXISTS(SELECT 1 FROM employee_monthly_run_request WHERE organization_id=NEW.organization_id AND idempotency_key=NEW.idempotency_key)
  OR TG_TABLE_NAME='employee_monthly_run_request' AND EXISTS(SELECT 1 FROM employee_earning_run_request WHERE organization_id=NEW.organization_id AND idempotency_key=NEW.idempotency_key)
 THEN RAISE EXCEPTION 'compensation creation nonce is already bound to its original earning intent';END IF;RETURN NEW;
END $$;
CREATE TRIGGER employee_earning_request_nonce_boundary BEFORE INSERT ON employee_earning_run_request FOR EACH ROW EXECUTE FUNCTION app_compensation_creation_request_nonce();
CREATE TRIGGER employee_monthly_request_nonce_boundary BEFORE INSERT ON employee_monthly_run_request FOR EACH ROW EXECUTE FUNCTION app_compensation_creation_request_nonce();

CREATE FUNCTION app_compensation_run_request_nonce() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE intent record;n integer=0;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended(NEW.organization_id::text||':employee-compensation-run-key:'||NEW.idempotency_key::text,0));
 FOR intent IN
  SELECT 'PER_MONTH'::text AS earning_kind,m.requested_by,m.request_fingerprint,m.policy_rule_id,(m.input->>'month'||'-01')::date AS from_on,((m.input->>'month'||'-01')::date+interval '1 month'-interval '1 day')::date AS to_on,p.value->>'timezone' AS timezone,m.input->>'currency' AS currency,m.input->>'purpose' AS purpose,m.input->>'reason' AS reason,o.id AS outcome_id
  FROM employee_monthly_run_request m JOIN config_rule p ON p.organization_id=m.organization_id AND p.id=m.policy_rule_id LEFT JOIN employee_monthly_run_outcome o ON o.organization_id=m.organization_id AND o.request_id=m.id WHERE m.organization_id=NEW.organization_id AND m.idempotency_key=NEW.idempotency_key
  UNION ALL
  SELECT e.earning_kind,e.requested_by,e.request_fingerprint,e.policy_rule_id,e.from_on,e.to_on,e.timezone,e.currency,e.input->>'purpose',e.input->>'reason',o.id
  FROM employee_earning_run_request e LEFT JOIN employee_earning_run_outcome o ON o.organization_id=e.organization_id AND o.request_id=e.id WHERE e.organization_id=NEW.organization_id AND e.idempotency_key=NEW.idempotency_key
 LOOP
  n=n+1;
  IF intent.outcome_id IS NOT NULL OR NEW.earning_kind IS DISTINCT FROM intent.earning_kind OR NEW.created_by IS DISTINCT FROM intent.requested_by OR NEW.request_fingerprint IS DISTINCT FROM intent.request_fingerprint OR NEW.policy_rule_id IS DISTINCT FROM intent.policy_rule_id
   OR NEW.from_on IS DISTINCT FROM intent.from_on OR NEW.to_on IS DISTINCT FROM intent.to_on OR NEW.timezone IS DISTINCT FROM intent.timezone OR NEW.currency IS DISTINCT FROM intent.currency OR NEW.purpose IS DISTINCT FROM intent.purpose OR NEW.reason IS DISTINCT FROM intent.reason
  THEN RAISE EXCEPTION 'financial run must retain its original pending creation intent';END IF;
 END LOOP;
 IF n>1 THEN RAISE EXCEPTION 'compensation nonce identifies conflicting earning requests';END IF;RETURN NEW;
END $$;
CREATE TRIGGER employee_compensation_creation_nonce_boundary BEFORE INSERT ON employee_compensation_run FOR EACH ROW EXECUTE FUNCTION app_compensation_run_request_nonce();

CREATE OR REPLACE FUNCTION app_employee_earning_request_complete() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE q employee_earning_run_request%ROWTYPE;s employee_earning_request_work%ROWTYPE;request_born xid;source_born xid;witness_born xid;task_uuid uuid;n integer;slot jsonb;
BEGIN
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
END $$;

CREATE OR REPLACE FUNCTION app_employee_monthly_outbox_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE q employee_monthly_run_request%ROWTYPE;earning employee_earning_run_request%ROWTYPE;
BEGIN
 IF TG_OP<>'INSERT' AND OLD.type IN('EmployeeMonthlyRunRequested','EmployeeEarningRunRequested') THEN
  IF TG_OP='DELETE' OR ROW(NEW.id,NEW.organization_id,NEW.type,NEW.payload,NEW.idempotency_key,NEW.occurred_at,NEW.created_at) IS DISTINCT FROM ROW(OLD.id,OLD.organization_id,OLD.type,OLD.payload,OLD.idempotency_key,OLD.occurred_at,OLD.created_at)
  THEN
   IF OLD.type='EmployeeMonthlyRunRequested' THEN RAISE EXCEPTION 'monthly worker reference is immutable';END IF;
   RAISE EXCEPTION 'actual earning worker reference is immutable';
  END IF;
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD;END IF;
 IF NEW.type='EmployeeMonthlyRunRequested' THEN
  SELECT * INTO q FROM employee_monthly_run_request WHERE organization_id=NEW.organization_id AND id::text=NEW.payload->>'requestId';
  IF q.id IS NULL OR NEW.payload<>jsonb_build_object('requestId',q.id::text) OR NEW.idempotency_key<>'employee-monthly-run-request:'||q.id::text||':requested' OR NEW.occurred_at<>q.requested_at THEN RAISE EXCEPTION 'monthly worker reference requires its actual private intent';END IF;
 ELSIF NEW.type='EmployeeEarningRunRequested' THEN
  SELECT * INTO earning FROM employee_earning_run_request WHERE organization_id=NEW.organization_id AND id::text=NEW.payload->>'requestId';
  IF earning.id IS NULL OR NEW.payload<>jsonb_build_object('requestId',earning.id::text) OR NEW.idempotency_key<>'employee-earning-run-request:'||earning.id::text||':requested' OR NEW.occurred_at<>date_trunc('milliseconds',earning.requested_at) THEN RAISE EXCEPTION 'actual earning worker reference requires its original private intent';END IF;
 END IF;RETURN NEW;
END $$;

COMMIT;
