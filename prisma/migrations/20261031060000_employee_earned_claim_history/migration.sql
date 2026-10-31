BEGIN;
-- An archived beneficiary still owns previously approved earnings. Acting accounts retain all current authorization checks.
CREATE OR REPLACE FUNCTION app_employee_recognition_admission() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE s employee_compensation_submission%ROWTYPE; c employee_compensation_claim%ROWTYPE;
BEGIN
 SELECT * INTO s FROM employee_compensation_submission WHERE organization_id=NEW.organization_id AND id=NEW.submission_id;
 SELECT * INTO c FROM employee_compensation_claim WHERE organization_id=NEW.organization_id AND id=NEW.claim_id;
 IF s.id IS NULL OR c.id IS NULL OR c.submission_id<>s.id
  OR EXISTS(SELECT 1 FROM employee_compensation_withdrawal WHERE organization_id=s.organization_id AND submission_id=s.id)
  OR EXISTS(SELECT 1 FROM employee_compensation_run_cancellation WHERE organization_id=s.organization_id AND run_id=s.run_id)
  OR NOT EXISTS(SELECT 1 FROM person WHERE organization_id=c.organization_id AND id=c.person_id)
  OR (jsonb_array_length(s.snapshot->'stages')>0 AND NOT EXISTS(SELECT 1 FROM approval_request a
   WHERE a.organization_id=s.organization_id AND a.employee_submission_id=s.id AND a.state='APPROVED'
    AND NOT EXISTS(SELECT 1 FROM approval_stage p WHERE p.organization_id=a.organization_id AND p.approval_id=a.id AND p.state<>'APPROVED')))
 THEN RAISE EXCEPTION 'employee recognition requires its actual approved unwithdrawn source and retained beneficiary';END IF;
 NEW.created_at=clock_timestamp();RETURN NEW;
END $$;
COMMIT;
