BEGIN;
CREATE FUNCTION app_employee_cost_notice_envelope_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE s employee_compensation_submission; c employee_compensation_cost; recipient_uuid uuid; owner_uuid uuid; cost_uuid uuid; source_uuid uuid; valid boolean;
BEGIN
 IF TG_OP='DELETE' THEN
  IF OLD.type='notification.requested' AND OLD.payload->>'kind'='employee_cost_emergency' THEN RAISE EXCEPTION 'employee cost notice source events are append-only';END IF;
  RETURN OLD;
 END IF;
 IF TG_OP='UPDATE' AND ((OLD.type='notification.requested' AND OLD.payload->>'kind'='employee_cost_emergency') OR (NEW.type='notification.requested' AND NEW.payload->>'kind'='employee_cost_emergency'))
  AND ROW(NEW.id,NEW.organization_id,NEW.type,NEW.payload,NEW.idempotency_key,NEW.occurred_at) IS DISTINCT FROM ROW(OLD.id,OLD.organization_id,OLD.type,OLD.payload,OLD.idempotency_key,OLD.occurred_at)
  THEN RAISE EXCEPTION 'employee cost notice source identity is immutable';END IF;
 IF NEW.type<>'notification.requested' OR NEW.payload->>'kind' IS DISTINCT FROM 'employee_cost_emergency' THEN RETURN NEW;END IF;
 source_uuid=(NEW.payload->'employeeNotice'->>'submissionId')::uuid;cost_uuid=(NEW.payload->'employeeNotice'->>'costId')::uuid;
 owner_uuid=(NEW.payload->'employeeNotice'->>'ownerId')::uuid;recipient_uuid=(NEW.payload->>'recipientId')::uuid;
 SELECT * INTO s FROM employee_compensation_submission WHERE organization_id=NEW.organization_id AND id=source_uuid;
 SELECT * INTO c FROM employee_compensation_cost WHERE organization_id=NEW.organization_id AND id=cost_uuid AND submission_id=source_uuid;
 SELECT EXISTS(SELECT 1 FROM jsonb_array_elements(c.policy_snapshot->'postHocNotices') x WHERE x->>'ownerId'=owner_uuid::text
  AND x->'recipients' @> jsonb_build_array(recipient_uuid::text) AND x->'routing'->'channels' @> '["in_app"]'::jsonb) INTO valid;
 IF s.id IS NULL OR NOT s.emergency OR c.id IS NULL OR valid IS DISTINCT FROM TRUE OR recipient_uuid IS NULL OR NEW.payload->>'targetId' IS DISTINCT FROM NEW.id::text
  OR NEW.idempotency_key IS DISTINCT FROM 'employee-cost:'||c.id::text||':emergency:'||owner_uuid::text||':'||recipient_uuid::text
  THEN RAISE EXCEPTION 'employee cost notice requires its actual source and frozen owner recipient';END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER employee_cost_notice_envelope_guard BEFORE INSERT OR UPDATE OR DELETE ON outbox_event
 FOR EACH ROW EXECUTE FUNCTION app_employee_cost_notice_envelope_guard();

CREATE FUNCTION app_employee_cost_notice_receipt_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE e outbox_event;
BEGIN
 IF TG_OP='DELETE' THEN
  IF OLD.kind='employee_cost_emergency' THEN RAISE EXCEPTION 'employee cost notice receipts are append-only';END IF;
  RETURN OLD;
 END IF;
 IF TG_OP='UPDATE' AND (OLD.kind='employee_cost_emergency' OR NEW.kind='employee_cost_emergency')
  AND ROW(NEW.id,NEW.organization_id,NEW.recipient_id,NEW.kind,NEW.event_id,NEW.target_id,NEW.created_at) IS DISTINCT FROM ROW(OLD.id,OLD.organization_id,OLD.recipient_id,OLD.kind,OLD.event_id,OLD.target_id,OLD.created_at)
  THEN RAISE EXCEPTION 'employee cost notice receipt identity is immutable';END IF;
 IF NEW.kind<>'employee_cost_emergency' THEN RETURN NEW;END IF;
 SELECT * INTO e FROM outbox_event WHERE organization_id=NEW.organization_id AND id=NEW.event_id;
 IF e.id IS NULL OR e.type<>'notification.requested' OR e.payload->>'kind' IS DISTINCT FROM NEW.kind OR e.id IS DISTINCT FROM NEW.target_id
  OR e.payload->>'recipientId' IS DISTINCT FROM NEW.recipient_id::text OR e.payload->>'targetId' IS DISTINCT FROM NEW.target_id::text
  THEN RAISE EXCEPTION 'employee cost notice receipt requires its actual immutable source event';END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER employee_cost_notice_receipt_guard BEFORE INSERT OR UPDATE OR DELETE ON notification
 FOR EACH ROW EXECUTE FUNCTION app_employee_cost_notice_receipt_guard();
COMMIT;
