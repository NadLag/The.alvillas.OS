BEGIN;
ALTER TABLE employee_monthly_run_request DROP CONSTRAINT employee_monthly_request_intent;
ALTER TABLE employee_monthly_run_request ADD CONSTRAINT employee_monthly_request_intent CHECK ((
 request_fingerprint~'^[a-f0-9]{64}$' AND reviewed_source_fingerprint~'^[a-f0-9]{64}$'
 AND jsonb_typeof(input)='object' AND jsonb_typeof(review)='object' AND jsonb_typeof(authorization_cap)='object'
 AND input->>'idempotencyKey'=idempotency_key::text AND input->>'month'~'^[0-9]{4}-(0[1-9]|1[0-2])$'
 AND input->>'currency'~'^[A-Z]{3}$' AND length(btrim(input->>'purpose')) BETWEEN 3 AND 1000
 AND length(btrim(input->>'reason')) BETWEEN 6 AND 500 AND jsonb_typeof(input->'assignments')='array'
 AND jsonb_array_length(input->'assignments') BETWEEN 1 AND 10000
 AND (input-'month'-'currency'-'assignments'-'purpose'-'reason'-'idempotencyKey')='{}'::jsonb
 AND authorization_cap->>'organizationId'=organization_id::text AND authorization_cap->>'userAccountId'=requested_by::text
 AND authorization_cap->>'schemaVersion'='1' AND review#>>'{amount,currency}'=input->>'currency'
 AND review#>>'{amount,amount}'~'^(0|[1-9][0-9]*)\.[0-9]{2}$' AND jsonb_typeof(review->'beneficiaries')='array'
 AND jsonb_array_length(review->'beneficiaries') BETWEEN 1 AND 10000 AND (review-'amount'-'beneficiaries'-'sources')='{}'::jsonb
) IS TRUE);

CREATE FUNCTION app_employee_monthly_request_original_sources() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE first_on date; end_on date; calendar_days integer; earning_timezone text;
BEGIN
 SELECT value->>'timezone' INTO earning_timezone FROM config_rule WHERE organization_id=NEW.organization_id AND id=NEW.policy_rule_id;
 first_on=(NEW.input->>'month'||'-01')::date;end_on=(first_on+interval '1 month')::date;calendar_days=end_on-first_on;
 IF jsonb_typeof(NEW.review->'sources') IS DISTINCT FROM 'array'
 OR jsonb_array_length(NEW.review->'sources')<>jsonb_array_length(NEW.input->'assignments')
 OR (SELECT count(DISTINCT source->>'assignmentId') FROM jsonb_array_elements(NEW.review->'sources') source)<>jsonb_array_length(NEW.review->'sources')
 OR EXISTS(SELECT 1 FROM jsonb_array_elements(NEW.review->'sources') source LEFT JOIN role_assignment a
  ON a.organization_id=NEW.organization_id AND a.id::text=source->>'assignmentId'
  WHERE a.id IS NULL OR a.person_id::text IS DISTINCT FROM source->>'personId' OR a.scope_type IS DISTINCT FROM source->>'scopeType'
   OR a.scope_id::text IS DISTINCT FROM source->>'scopeId' OR NOT(source ? 'scopeId')
   OR (source-'assignmentId'-'personId'-'scopeType'-'scopeId'-'days')<>'{}'::jsonb
   OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(NEW.input->'assignments') selected WHERE selected->>'assignmentId'=source->>'assignmentId')
   OR jsonb_typeof(source->'days') IS DISTINCT FROM 'array' OR jsonb_array_length(source->'days')<>calendar_days
   OR (SELECT count(DISTINCT day->>'on') FROM jsonb_array_elements(source->'days') day)<>calendar_days)
 OR EXISTS(SELECT 1 FROM jsonb_array_elements(NEW.review->'sources') source CROSS JOIN LATERAL jsonb_array_elements(source->'days') day
  LEFT JOIN LATERAL(SELECT c.id FROM team_compensation c WHERE c.organization_id=NEW.organization_id AND c.assignment_id::text=source->>'assignmentId'
    AND c.effective_from<=((day->>'on')::date::timestamp AT TIME ZONE earning_timezone) ORDER BY c.version DESC LIMIT 1) actual ON true
  WHERE (day->>'on')::date<first_on OR (day->>'on')::date>=end_on OR (day->>'on')::date::text IS DISTINCT FROM day->>'on'
   OR actual.id::text IS DISTINCT FROM day->>'compensationId' OR NOT(day ? 'compensationId') OR (day-'on'-'compensationId')<>'{}'::jsonb)
 THEN RAISE EXCEPTION 'monthly request requires every actual original daily contract reference and original assignment scope';END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER employee_monthly_request_original_sources BEFORE INSERT ON employee_monthly_run_request FOR EACH ROW EXECUTE FUNCTION app_employee_monthly_request_original_sources();

CREATE FUNCTION app_employee_monthly_outcome_original_sources() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE q employee_monthly_run_request%ROWTYPE;
BEGIN
 IF NEW.state<>'SUCCEEDED' THEN RETURN NEW;END IF;
 SELECT * INTO q FROM employee_monthly_run_request WHERE organization_id=NEW.organization_id AND id=NEW.request_id;
 IF jsonb_typeof(q.review->'sources') IS DISTINCT FROM 'array'
 OR EXISTS(SELECT 1 FROM jsonb_array_elements(q.review->'sources') source CROSS JOIN LATERAL jsonb_array_elements(source->'days') day
  LEFT JOIN employee_compensation_run_line line ON line.organization_id=NEW.organization_id AND line.run_id=NEW.run_id AND line.assignment_id::text=source->>'assignmentId'
  LEFT JOIN employee_compensation_contract_witness witness ON witness.organization_id=NEW.organization_id AND witness.run_line_id=line.id AND witness.source_on=(day->>'on')::date
  WHERE witness.id IS NULL OR witness.compensation_id::text IS DISTINCT FROM day->>'compensationId')
 THEN RAISE EXCEPTION 'monthly success requires the actual original reviewed daily contractual witnesses';END IF;
 RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER employee_monthly_outcome_original_sources AFTER INSERT ON employee_monthly_run_outcome DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app_employee_monthly_outcome_original_sources();

COMMIT;
