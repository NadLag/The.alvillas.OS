BEGIN;
CREATE FUNCTION app_assert_employee_percentage_cost(n employee_compensation_cost,s employee_compensation_submission,c employee_compensation_claim,l employee_compensation_run_line,expected jsonb) RETURNS void
LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE posting_ids jsonb;lock_key text;journal_uuid uuid;
BEGIN
 IF c.id IS NULL OR l.id IS NULL OR c.organization_id<>n.organization_id OR s.organization_id<>n.organization_id OR l.organization_id<>n.organization_id
  OR c.submission_id<>s.id OR l.run_id<>s.run_id OR c.person_id<>l.person_id OR l.earning_kind<>'PERCENTAGE'
  OR n.amount<>l.amount OR n.currency<>l.currency OR n.amount<=0 OR n.completion_event_id IS NOT NULL OR l.completion_event_id IS NOT NULL
  OR n.property_id IS DISTINCT FROM l.property_id OR expected IS NULL
 THEN RAISE EXCEPTION 'percentage cost requires its actual immutable earning and beneficiary';END IF;
 FOR lock_key IN SELECT DISTINCT 'percentage:'||line.person_id::text||':'||w.posting_id::text
   FROM employee_compensation_run_line line JOIN employee_compensation_percentage_witness w ON w.organization_id=line.organization_id AND w.run_line_id=line.id
   WHERE line.organization_id=n.organization_id AND line.run_id=s.run_id AND w.is_earning_base ORDER BY 1 LOOP
  PERFORM pg_advisory_xact_lock(hashtextextended(n.organization_id::text||':employee-earned-source:'||lock_key,0));
 END LOOP;
 FOR journal_uuid IN SELECT DISTINCT p.transaction_id FROM employee_compensation_percentage_witness w JOIN posting p ON p.organization_id=w.organization_id AND p.id=w.posting_id
  WHERE w.organization_id=n.organization_id AND w.run_line_id=l.id ORDER BY 1 LOOP
  PERFORM pg_advisory_xact_lock(hashtextextended(n.organization_id::text||':journal-reversal:'||journal_uuid::text,0));
 END LOOP;
 PERFORM app_assert_employee_percentage_line(l.organization_id,l.id);
 SELECT jsonb_agg(w.posting_id::text ORDER BY w.posting_id::text) INTO posting_ids FROM employee_compensation_percentage_witness w WHERE w.organization_id=n.organization_id AND w.run_line_id=l.id AND w.is_earning_base;
 IF expected->>'earningKind' IS DISTINCT FROM 'PERCENTAGE' OR expected->>'assignmentId' IS DISTINCT FROM l.assignment_id::text OR expected->'percentagePostingIds' IS DISTINCT FROM posting_ids
  OR n.policy_snapshot->>'schemaVersion' IS DISTINCT FROM '1' OR n.policy_snapshot->>'sourceKind' IS DISTINCT FROM 'employee_compensation_run_line'
  OR n.policy_snapshot->>'earningKind' IS DISTINCT FROM 'PERCENTAGE' OR n.policy_snapshot->>'assignmentId' IS DISTINCT FROM l.assignment_id::text OR n.policy_snapshot->'percentagePostingIds' IS DISTINCT FROM posting_ids
  OR n.policy_snapshot->>'runId' IS DISTINCT FROM l.run_id::text OR n.policy_snapshot->>'runLineId' IS DISTINCT FROM l.id::text OR n.policy_snapshot->>'personId' IS DISTINCT FROM l.person_id::text
  OR NOT(n.policy_snapshot ? 'completionEventId') OR n.policy_snapshot->>'completionEventId' IS NOT NULL
  OR expected->>'personId' IS DISTINCT FROM c.person_id::text OR expected->>'taskId' IS DISTINCT FROM l.task_id::text
  OR NOT(expected ? 'completionEventId') OR expected->>'completionEventId' IS NOT NULL OR NOT(expected ? 'propertyId') OR NOT(expected ? 'taskId')
  OR expected->>'propertyId' IS DISTINCT FROM n.property_id::text OR expected->>'reservationId' IS DISTINCT FROM n.reservation_id::text
  OR expected->>'category' IS DISTINCT FROM n.category OR expected->>'costCenter' IS DISTINCT FROM n.cost_center OR expected->>'note' IS DISTINCT FROM n.note OR expected->>'timezone' IS DISTINCT FROM n.timezone
  OR expected->>'costOn' IS DISTINCT FROM s.cost_on::text OR expected->>'recordedCompletionAt' IS DISTINCT FROM to_char(l.recorded_completion_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  OR (expected#>>'{amount,amount}')::numeric IS DISTINCT FROM n.amount OR expected#>>'{amount,currency}' IS DISTINCT FROM n.currency OR expected->'policy' IS DISTINCT FROM n.policy_snapshot
  OR n.policy_snapshot->>'propertyId' IS DISTINCT FROM n.property_id::text OR n.policy_snapshot->>'reservationId' IS DISTINCT FROM n.reservation_id::text
  OR n.policy_snapshot->>'recordedCompletionAt' IS DISTINCT FROM expected->>'recordedCompletionAt'
  OR n.policy_snapshot->>'occurredOn' IS DISTINCT FROM s.cost_on::text OR n.policy_snapshot->>'timezone' IS DISTINCT FROM n.timezone OR n.policy_snapshot->>'category' IS DISTINCT FROM n.category
  OR(n.policy_snapshot#>>'{amount,amount}')::numeric IS DISTINCT FROM n.amount OR n.policy_snapshot#>>'{amount,currency}' IS DISTINCT FROM n.currency
  OR n.reservation_id IS DISTINCT FROM(SELECT reservation_id FROM operation_task WHERE organization_id=n.organization_id AND id=l.task_id)
 THEN RAISE EXCEPTION 'percentage cost requires every exact original typed posting and retained approved policy';END IF;
 IF n.property_id IS NULL AND(n.reservation_id IS NOT NULL OR NOT(n.policy_snapshot ? 'propertyId') OR NOT(n.policy_snapshot ? 'reservationId')
  OR(n.policy_snapshot#>>'{allocation,owner,amount}')::numeric IS DISTINCT FROM 0 OR(n.policy_snapshot#>>'{allocation,guest,amount}')::numeric IS DISTINCT FROM 0
  OR(n.policy_snapshot#>>'{allocation,alvillas,amount}')::numeric IS DISTINCT FROM n.amount
  OR jsonb_array_length(n.policy_snapshot->'policies') IS DISTINCT FROM 1 OR n.policy_snapshot#>>'{policies,0,organizationId}' IS DISTINCT FROM n.organization_id::text)
 THEN RAISE EXCEPTION 'company percentage costs cannot invent property or owner money';END IF;
 IF EXISTS(SELECT 1 FROM employee_compensation_cost old_cost
  JOIN employee_compensation_submission prior ON prior.organization_id=old_cost.organization_id AND prior.id=old_cost.submission_id
  JOIN employee_compensation_run_line prior_line ON prior_line.organization_id=old_cost.organization_id AND prior_line.id=old_cost.run_line_id
  JOIN employee_compensation_percentage_witness prior_w ON prior_w.organization_id=prior_line.organization_id AND prior_w.run_line_id=prior_line.id AND prior_w.is_earning_base
  JOIN employee_compensation_percentage_witness current_w ON current_w.organization_id=prior_w.organization_id AND current_w.posting_id=prior_w.posting_id AND current_w.run_line_id=l.id AND current_w.is_earning_base
  LEFT JOIN approval_request a ON a.organization_id=prior.organization_id AND a.employee_submission_id=prior.id
  WHERE old_cost.organization_id=n.organization_id AND old_cost.id<>n.id AND prior_line.earning_kind='PERCENTAGE' AND prior_line.person_id=l.person_id
   AND NOT EXISTS(SELECT 1 FROM employee_compensation_withdrawal w WHERE w.organization_id=prior.organization_id AND w.submission_id=prior.id)
   AND COALESCE(a.state,'APPROVED')<>'REJECTED')
 THEN RAISE EXCEPTION 'original percentage posting already belongs to an active claim for this beneficiary';END IF;
END $$;
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
  IF l.earning_kind='PERCENTAGE' THEN PERFORM app_assert_employee_percentage_cost(NEW,s,c,l,expected);NEW.created_at=clock_timestamp();RETURN NEW;END IF;

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
COMMIT;
