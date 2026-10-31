BEGIN;

CREATE FUNCTION app_guard_employee_hourly_assignment_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.id,NEW.organization_id,NEW.person_id,NEW.role_id,NEW.scope_type,NEW.scope_id,NEW.valid_from)
     IS DISTINCT FROM ROW(OLD.id,OLD.organization_id,OLD.person_id,OLD.role_id,OLD.scope_type,OLD.scope_id,OLD.valid_from)
     AND EXISTS (
       SELECT 1 FROM employee_compensation_hourly_witness w
       JOIN team_compensation c ON c.organization_id=w.organization_id AND c.id=w.compensation_id
       WHERE c.organization_id=OLD.organization_id AND c.assignment_id=OLD.id
     ) THEN
    RAISE EXCEPTION 'Original hourly earning assignment identity is immutable; retire it and append a replacement' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER employee_hourly_assignment_identity_immutable BEFORE UPDATE ON role_assignment
FOR EACH ROW EXECUTE FUNCTION app_guard_employee_hourly_assignment_identity();

COMMIT;
