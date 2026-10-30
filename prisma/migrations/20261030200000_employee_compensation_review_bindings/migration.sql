BEGIN;

CREATE OR REPLACE FUNCTION app_assert_employee_submission(org uuid,source_id uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE s employee_compensation_submission%ROWTYPE; r employee_compensation_run%ROWTYPE; a approval_request%ROWTYPE; cost_count integer; total_amount numeric; expected jsonb; stage approval_stage%ROWTYPE; audience text[]; actual text[];
BEGIN
 SELECT * INTO s FROM employee_compensation_submission WHERE organization_id=org AND id=source_id;IF NOT FOUND THEN RETURN; END IF;
 SELECT * INTO r FROM employee_compensation_run WHERE organization_id=org AND id=s.run_id;
 SELECT count(*),sum(amount) INTO cost_count,total_amount FROM employee_compensation_cost WHERE organization_id=org AND submission_id=s.id;
 IF r.id IS NULL OR cost_count=0 OR cost_count<>(SELECT count(*) FROM employee_compensation_run_line WHERE organization_id=org AND run_id=r.id AND amount>0)
  OR cost_count<>jsonb_array_length(s.snapshot->'costs') OR total_amount IS DISTINCT FROM (s.snapshot#>>'{total,amount}')::numeric
  OR s.snapshot->>'kind' IS DISTINCT FROM 'EMPLOYEE_COMPENSATION_COSTS' OR s.snapshot->>'runId' IS DISTINCT FROM r.id::text OR s.snapshot->>'costOn' IS DISTINCT FROM s.cost_on::text
  OR s.snapshot#>>'{total,currency}' IS DISTINCT FROM r.currency
  OR EXISTS(SELECT 1 FROM employee_compensation_claim claim WHERE claim.organization_id=org AND claim.submission_id=s.id
   AND NOT EXISTS(SELECT 1 FROM employee_compensation_cost cost WHERE cost.organization_id=org AND cost.claim_id=claim.id))
 THEN RAISE EXCEPTION 'employee submission requires every original positive source and derived total'; END IF;
 SELECT * INTO a FROM approval_request WHERE organization_id=org AND employee_submission_id=s.id;
 IF jsonb_array_length(s.snapshot->'stages')=0 THEN
  IF a.id IS NOT NULL THEN RAISE EXCEPTION 'employee review cannot add an unconfigured stage'; END IF;
 ELSE
  IF a.id IS NULL OR (SELECT count(*) FROM approval_stage WHERE organization_id=org AND approval_id=a.id)<>jsonb_array_length(s.snapshot->'stages')
  THEN RAISE EXCEPTION 'employee submission requires its complete configured review'; END IF;
  FOR stage IN SELECT * FROM approval_stage WHERE organization_id=org AND approval_id=a.id ORDER BY position LOOP
   expected=s.snapshot->'stages'->(stage.position-1);
   SELECT array_agg(value ORDER BY value) INTO audience FROM jsonb_array_elements_text(expected->'recipients');
   SELECT array_agg(user_account_id::text ORDER BY user_account_id::text) INTO actual FROM approval_stage_recipient WHERE organization_id=org AND stage_id=stage.id;
   IF audience IS NULL OR actual IS DISTINCT FROM audience THEN RAISE EXCEPTION 'employee review requires its frozen stage audience'; END IF;
  END LOOP;
  SELECT array_agg(DISTINCT member ORDER BY member) INTO audience FROM jsonb_array_elements(s.snapshot->'stages') configured_stage CROSS JOIN LATERAL jsonb_array_elements_text(configured_stage->'recipients') member;
  SELECT array_agg(user_account_id::text ORDER BY user_account_id::text) INTO actual FROM approval_recipient WHERE organization_id=org AND approval_id=a.id;
  IF actual IS DISTINCT FROM audience THEN RAISE EXCEPTION 'employee review requires only its frozen audience'; END IF;
 END IF;
 IF (SELECT count(*) FROM audit_log WHERE organization_id=org AND resource_type='employee_compensation_submission' AND resource_id=s.id AND action='finance.employee_compensation.submitted')<>1
  OR NOT EXISTS(SELECT 1 FROM audit_log WHERE organization_id=org AND resource_type='employee_compensation_submission' AND resource_id=s.id AND action='finance.employee_compensation.submitted'
   AND actor_id=s.submitted_by AND reason=s.reason AND after->>'submissionId'=s.id::text AND after->>'runId'=r.id::text
   AND (after->>'costCount')::integer=cost_count AND (after->>'claimCount')::integer=(SELECT count(*) FROM employee_compensation_claim WHERE organization_id=org AND submission_id=s.id)
   AND (after#>>'{total,amount}')::numeric=total_amount AND after#>>'{total,currency}'=r.currency)
  OR NOT EXISTS(SELECT 1 FROM outbox_event WHERE organization_id=org AND type='EmployeeCompensationSubmitted' AND idempotency_key='employee-compensation-submission:'||s.id::text||':EmployeeCompensationSubmitted' AND payload=jsonb_build_object('submissionId',s.id::text))
 THEN RAISE EXCEPTION 'employee submission requires its actual atomic attribution and event'; END IF;
END $$;

CREATE OR REPLACE FUNCTION app_employee_review_complete() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE a approval_request%ROWTYPE; source_id uuid; review_approval_id uuid; folded text; stage approval_stage%ROWTYPE;
BEGIN
 IF TG_TABLE_NAME='approval_request' THEN review_approval_id=NEW.id;ELSE review_approval_id=NEW.approval_id;END IF;
 SELECT * INTO a FROM approval_request WHERE organization_id=NEW.organization_id AND id=review_approval_id;
 IF a.employee_submission_id IS NULL THEN RETURN NEW;END IF;source_id=a.employee_submission_id;
 SELECT CASE WHEN count(*) FILTER(WHERE state='REJECTED')>0 THEN 'REJECTED'
  WHEN count(*)>0 AND count(*)=count(*) FILTER(WHERE state='APPROVED') THEN 'APPROVED' ELSE 'PENDING' END
  INTO folded FROM approval_stage WHERE organization_id=a.organization_id AND approval_id=a.id;
 IF a.state IS DISTINCT FROM folded OR (folded<>'PENDING' AND EXISTS(SELECT 1 FROM approval_stage WHERE organization_id=a.organization_id AND approval_id=a.id AND state='PENDING'))
 THEN RAISE EXCEPTION 'employee approval must reflect its actual configured stage decisions';END IF;
 FOR stage IN SELECT * FROM approval_stage WHERE organization_id=a.organization_id AND approval_id=a.id AND state IN('APPROVED','REJECTED') LOOP
  IF NOT EXISTS(SELECT 1 FROM audit_log x WHERE x.organization_id=a.organization_id AND x.resource_type='employee_compensation_submission' AND x.resource_id=source_id
   AND x.action='finance.employee_compensation.approval_stage_decided' AND x.actor_id=stage.decided_by AND x.reason=stage.decision_reason
   AND x.after->>'stageId'=stage.id::text AND x.after->>'state'=stage.state AND x.after->>'lineId'=stage.employee_cost_id::text
   AND (x.after->>'amount')::numeric=stage.amount AND x.after->>'currency'=stage.currency)
  THEN RAISE EXCEPTION 'employee cost decision requires its exact attributed source audit';END IF;
 END LOOP;
 IF folded<>'PENDING' AND NOT EXISTS(SELECT 1 FROM audit_log x WHERE x.organization_id=a.organization_id AND x.resource_type='employee_compensation_submission' AND x.resource_id=source_id
  AND x.action='finance.employee_compensation.'||lower(folded) AND x.actor_id=a.decided_by AND x.reason=a.decision_reason AND x.after->>'approvalId'=a.id::text AND x.after->>'state'=folded)
 THEN RAISE EXCEPTION 'employee review completion requires its actual attributed audit';END IF;
 RETURN NEW;
END $$;

COMMIT;
