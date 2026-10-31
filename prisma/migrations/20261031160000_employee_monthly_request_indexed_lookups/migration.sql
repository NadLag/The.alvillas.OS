BEGIN;
CREATE OR REPLACE FUNCTION app_employee_monthly_request_original_sources() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE first_on date; end_on date; calendar_days integer; earning_timezone text;
BEGIN
 SELECT value->>'timezone' INTO earning_timezone FROM config_rule WHERE organization_id=NEW.organization_id AND id=NEW.policy_rule_id;
 first_on=(NEW.input->>'month'||'-01')::date;end_on=(first_on+interval '1 month')::date;calendar_days=end_on-first_on;
 IF jsonb_typeof(NEW.review->'sources') IS DISTINCT FROM 'array'
 OR jsonb_array_length(NEW.review->'sources')<>jsonb_array_length(NEW.input->'assignments')
 OR (SELECT count(DISTINCT source->>'assignmentId') FROM jsonb_array_elements(NEW.review->'sources') source)<>jsonb_array_length(NEW.review->'sources')
 OR EXISTS(SELECT 1 FROM jsonb_array_elements(NEW.review->'sources') source LEFT JOIN role_assignment a
  ON a.organization_id=NEW.organization_id AND a.id=(source->>'assignmentId')::uuid
  WHERE a.id IS NULL OR a.person_id::text IS DISTINCT FROM source->>'personId' OR a.scope_type IS DISTINCT FROM source->>'scopeType'
   OR a.scope_id::text IS DISTINCT FROM source->>'scopeId' OR NOT(source ? 'scopeId')
   OR (source-'assignmentId'-'personId'-'scopeType'-'scopeId'-'days')<>'{}'::jsonb
   OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(NEW.input->'assignments') selected WHERE selected->>'assignmentId'=source->>'assignmentId')
   OR jsonb_typeof(source->'days') IS DISTINCT FROM 'array' OR jsonb_array_length(source->'days')<>calendar_days
   OR (SELECT count(DISTINCT day->>'on') FROM jsonb_array_elements(source->'days') day)<>calendar_days)
 OR EXISTS(SELECT 1 FROM jsonb_array_elements(NEW.review->'sources') source CROSS JOIN LATERAL jsonb_array_elements(source->'days') day
  LEFT JOIN LATERAL(SELECT c.id FROM team_compensation c WHERE c.organization_id=NEW.organization_id AND c.assignment_id=(source->>'assignmentId')::uuid
    AND c.effective_from<=((day->>'on')::date::timestamp AT TIME ZONE earning_timezone) ORDER BY c.version DESC LIMIT 1) actual ON true
  WHERE (day->>'on')::date<first_on OR (day->>'on')::date>=end_on OR (day->>'on')::date::text IS DISTINCT FROM day->>'on'
   OR actual.id::text IS DISTINCT FROM day->>'compensationId' OR NOT(day ? 'compensationId') OR (day-'on'-'compensationId')<>'{}'::jsonb)
 THEN RAISE EXCEPTION 'monthly request requires every actual original daily contract reference and original assignment scope';END IF;
 RETURN NEW;
END $$;
COMMIT;
