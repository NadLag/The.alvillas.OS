BEGIN;
ALTER TABLE notification DROP CONSTRAINT notification_resolution_check;
ALTER TABLE notification ADD CONSTRAINT notification_resolution_check CHECK
 ((resolution IS NULL AND resolved_at IS NULL) OR (resolution IN ('APPROVED','REJECTED','CANCELLED') AND resolved_at IS NOT NULL));

-- Withdrawal resolves an existing review receipt; the original review and financial source remain intact.
CREATE FUNCTION app_employee_review_notice_cancellation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='UPDATE' AND OLD.resolution='CANCELLED' AND ROW(NEW.resolution,NEW.resolved_at) IS DISTINCT FROM ROW(OLD.resolution,OLD.resolved_at)
 THEN RAISE EXCEPTION 'retained employee review cancellation cannot be rewritten';END IF;
 IF NEW.resolution IS DISTINCT FROM 'CANCELLED' THEN RETURN NEW;END IF;
 IF TG_OP<>'UPDATE' THEN RAISE EXCEPTION 'employee review cancellation resolves only an existing actual receipt';END IF;
 IF ROW(NEW.id,NEW.organization_id,NEW.recipient_id,NEW.kind,NEW.target_id,NEW.created_at)
   IS DISTINCT FROM ROW(OLD.id,OLD.organization_id,OLD.recipient_id,OLD.kind,OLD.target_id,OLD.created_at)
  OR NEW.kind<>'approval_requested' OR (OLD.resolution IS NOT NULL AND
   (OLD.resolution<>'CANCELLED' OR NEW.resolved_at IS DISTINCT FROM OLD.resolved_at))
  OR NOT EXISTS(SELECT 1 FROM approval_request a JOIN employee_compensation_withdrawal w
   ON w.organization_id=a.organization_id AND w.submission_id=a.employee_submission_id
   WHERE a.organization_id=NEW.organization_id AND a.id=NEW.target_id AND NEW.resolved_at>=w.created_at)
 THEN RAISE EXCEPTION 'employee review cancellation requires its retained actual withdrawn source';END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER employee_review_notice_cancellation BEFORE INSERT OR UPDATE ON notification FOR EACH ROW EXECUTE FUNCTION app_employee_review_notice_cancellation();
COMMIT;
