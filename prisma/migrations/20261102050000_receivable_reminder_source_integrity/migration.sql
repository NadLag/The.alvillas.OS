BEGIN;
-- Extend the existing kind constraint without replacing its admitted history.
DO $$
DECLARE previous_check text;
BEGIN
 SELECT pg_get_expr(conbin,conrelid) INTO STRICT previous_check FROM pg_constraint
  WHERE conrelid='notification'::regclass AND conname='notification_kind_check';
 EXECUTE format('ALTER TABLE notification ADD CONSTRAINT notification_kind_with_receivable_reminder CHECK ((%s) OR kind=%L)',previous_check,'receivable_reminder');
 ALTER TABLE notification DROP CONSTRAINT notification_kind_check;
 ALTER TABLE notification RENAME CONSTRAINT notification_kind_with_receivable_reminder TO notification_kind_check;
END $$;

CREATE FUNCTION app_receivable_reminder_envelope_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE notice jsonb;assignment_row receivable_assignment;policy config_rule;routing config_rule;recipient_uuid uuid;
BEGIN
 IF TG_OP='DELETE' THEN
  IF OLD.type='notification.requested' AND OLD.payload->>'kind'='receivable_reminder' THEN RAISE EXCEPTION 'receivable reminder source events are append-only';END IF;
  RETURN OLD;
 END IF;
 IF TG_OP='UPDATE' THEN
  IF ((OLD.type='notification.requested' AND OLD.payload->>'kind'='receivable_reminder') OR (NEW.type='notification.requested' AND NEW.payload->>'kind'='receivable_reminder'))
   AND ROW(NEW.id,NEW.organization_id,NEW.type,NEW.payload,NEW.idempotency_key,NEW.occurred_at) IS DISTINCT FROM ROW(OLD.id,OLD.organization_id,OLD.type,OLD.payload,OLD.idempotency_key,OLD.occurred_at)
  THEN RAISE EXCEPTION 'receivable reminder source identity is immutable';END IF;
  RETURN NEW;
 END IF;
 IF NEW.type<>'notification.requested' OR NEW.payload->>'kind' IS DISTINCT FROM 'receivable_reminder' THEN RETURN NEW;END IF;
 notice=NEW.payload->'receivableNotice';recipient_uuid=(NEW.payload->>'recipientId')::uuid;
 SELECT * INTO assignment_row FROM receivable_assignment WHERE organization_id=NEW.organization_id AND id=(notice->>'assignmentId')::uuid;
 SELECT * INTO policy FROM config_rule WHERE organization_id=NEW.organization_id AND id=(notice->>'policyId')::uuid;
 SELECT * INTO routing FROM config_rule WHERE organization_id=NEW.organization_id AND id=(notice->>'routingRuleId')::uuid;
 IF assignment_row.id IS NULL OR assignment_row.due_on IS NULL OR assignment_row.currency::text IS DISTINCT FROM notice->>'currency'
  OR recipient_uuid IS NULL OR NOT EXISTS(SELECT 1 FROM user_account WHERE organization_id=NEW.organization_id AND id=recipient_uuid)
  OR policy.id IS NULL OR policy.key<>'finance.receivable_reminders' OR policy.scope_type<>'organization' OR policy.scope_id IS NOT NULL
  OR routing.id IS NULL OR routing.key<>'notification.routing.receivable_reminder' OR routing.scope_type<>'organization' OR routing.scope_id IS NOT NULL
  OR notice->'routing' IS DISTINCT FROM routing.value OR routing.value->>'assigned' IS DISTINCT FROM 'false'
  OR jsonb_typeof(notice) IS DISTINCT FROM 'object'
  OR (notice-ARRAY['assignmentId','policyId','routingRuleId','on','occurrenceOn','stage','currency','routing'])<>'{}'::jsonb
  OR (NEW.payload-ARRAY['kind','recipientId','targetId','receivableNotice'])<>'{}'::jsonb
  OR notice->>'on' IS NULL OR notice->>'occurrenceOn' IS NULL OR NOT isfinite((notice->>'on')::date) OR NOT isfinite((notice->>'occurrenceOn')::date)
  OR (notice->>'occurrenceOn')::date>(notice->>'on')::date
  OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(policy.value->'stages') stage WHERE stage->>'key'=notice->>'stage')
  OR NEW.payload->>'targetId' IS DISTINCT FROM NEW.id::text
  OR NEW.idempotency_key IS DISTINCT FROM 'receivable-reminder:'||policy.id::text||':'||assignment_row.id::text||':'||(notice->>'stage')||':'||(notice->>'occurrenceOn')||':'||recipient_uuid::text
 THEN RAISE EXCEPTION 'receivable reminder requires its actual tenant claim, policy, configured audience and occurrence';END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER receivable_reminder_envelope_guard BEFORE INSERT OR UPDATE OR DELETE ON outbox_event
 FOR EACH ROW EXECUTE FUNCTION app_receivable_reminder_envelope_guard();

CREATE FUNCTION app_receivable_reminder_receipt_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE event_row outbox_event;
BEGIN
 IF TG_OP='DELETE' THEN
  IF OLD.kind='receivable_reminder' THEN RAISE EXCEPTION 'receivable reminder receipts are append-only';END IF;
  RETURN OLD;
 END IF;
 IF TG_OP='UPDATE' AND (OLD.kind='receivable_reminder' OR NEW.kind='receivable_reminder')
  AND ROW(NEW.id,NEW.organization_id,NEW.recipient_id,NEW.kind,NEW.event_id,NEW.target_id,NEW.created_at) IS DISTINCT FROM ROW(OLD.id,OLD.organization_id,OLD.recipient_id,OLD.kind,OLD.event_id,OLD.target_id,OLD.created_at)
 THEN RAISE EXCEPTION 'receivable reminder receipt identity is immutable';END IF;
 IF NEW.kind<>'receivable_reminder' THEN RETURN NEW;END IF;
 SELECT * INTO event_row FROM outbox_event WHERE organization_id=NEW.organization_id AND id=NEW.event_id;
 IF event_row.id IS NULL OR event_row.type<>'notification.requested' OR event_row.payload->>'kind' IS DISTINCT FROM NEW.kind
  OR event_row.id IS DISTINCT FROM NEW.target_id OR event_row.payload->>'recipientId' IS DISTINCT FROM NEW.recipient_id::text
  OR event_row.payload->>'targetId' IS DISTINCT FROM NEW.target_id::text OR NEW.created_at IS DISTINCT FROM event_row.occurred_at
 THEN RAISE EXCEPTION 'receivable reminder receipt requires its actual immutable source event';END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER receivable_reminder_receipt_guard BEFORE INSERT OR UPDATE OR DELETE ON notification
 FOR EACH ROW EXECUTE FUNCTION app_receivable_reminder_receipt_guard();
COMMIT;
