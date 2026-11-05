BEGIN;
-- Retain original failed-check references and source identities; no business DML.
CREATE FUNCTION app_ledger_integrity_notice_envelope_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE notice jsonb;run_row ledger_integrity_run;policy config_rule;routing config_rule;recipient_uuid uuid;
BEGIN
 IF TG_OP='DELETE' THEN
  IF OLD.type='notification.requested' AND OLD.payload->>'kind'='ledger_integrity_failed' THEN RAISE EXCEPTION 'ledger integrity notice sources are append-only';END IF;
  RETURN OLD;
 END IF;
 IF TG_OP='UPDATE' THEN
  IF ((OLD.type='notification.requested' AND OLD.payload->>'kind'='ledger_integrity_failed') OR (NEW.type='notification.requested' AND NEW.payload->>'kind'='ledger_integrity_failed'))
   AND ROW(NEW.id,NEW.organization_id,NEW.type,NEW.payload,NEW.idempotency_key,NEW.occurred_at) IS DISTINCT FROM ROW(OLD.id,OLD.organization_id,OLD.type,OLD.payload,OLD.idempotency_key,OLD.occurred_at)
  THEN RAISE EXCEPTION 'ledger integrity notice source identity is immutable';END IF;
  RETURN NEW;
 END IF;
 IF NEW.type<>'notification.requested' OR NEW.payload->>'kind' IS DISTINCT FROM 'ledger_integrity_failed' THEN RETURN NEW;END IF;
 notice=NEW.payload->'integrityNotice';recipient_uuid=(NEW.payload->>'recipientId')::uuid;
 SELECT * INTO run_row FROM ledger_integrity_run WHERE organization_id=NEW.organization_id AND id=(notice->>'runId')::uuid;
 SELECT * INTO policy FROM config_rule WHERE organization_id=NEW.organization_id AND id=(notice->>'policyId')::uuid;
 SELECT * INTO routing FROM config_rule WHERE organization_id=NEW.organization_id AND id=(notice->>'routingRuleId')::uuid;
 IF run_row.id IS NULL OR run_row.passed IS DISTINCT FROM false OR run_row.policy_rule_id IS DISTINCT FROM policy.id
  OR recipient_uuid IS NULL OR NOT EXISTS(SELECT 1 FROM user_account WHERE organization_id=NEW.organization_id AND id=recipient_uuid)
  OR policy.id IS NULL OR policy.key<>'finance.ledger_integrity' OR policy.scope_type<>'organization' OR policy.scope_id IS NOT NULL
  OR routing.id IS NULL OR routing.key<>'notification.routing.ledger_integrity_failed' OR routing.scope_type<>'organization' OR routing.scope_id IS NOT NULL
  OR notice->'routing' IS DISTINCT FROM routing.value OR routing.value->>'assigned' IS DISTINCT FROM 'false'
  OR jsonb_typeof(notice) IS DISTINCT FROM 'object'
  OR (notice-ARRAY['runId','policyId','routingRuleId','routing'])<>'{}'::jsonb
  OR (NEW.payload-ARRAY['kind','recipientId','targetId','integrityNotice'])<>'{}'::jsonb
  OR NEW.payload->>'targetId' IS DISTINCT FROM NEW.id::text
  OR NEW.idempotency_key IS DISTINCT FROM 'ledger-integrity:'||run_row.id::text||':'||recipient_uuid::text
 THEN RAISE EXCEPTION 'ledger integrity notice requires its actual tenant failed run, policy and configured audience';END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER ledger_integrity_notice_envelope_guard BEFORE INSERT OR UPDATE OR DELETE ON outbox_event
 FOR EACH ROW EXECUTE FUNCTION app_ledger_integrity_notice_envelope_guard();

CREATE FUNCTION app_ledger_integrity_notice_receipt_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE event_row outbox_event;
BEGIN
 IF TG_OP='DELETE' THEN
  IF OLD.kind='ledger_integrity_failed' THEN RAISE EXCEPTION 'ledger integrity notice receipts are append-only';END IF;
  RETURN OLD;
 END IF;
 IF TG_OP='UPDATE' AND (OLD.kind='ledger_integrity_failed' OR NEW.kind='ledger_integrity_failed')
  AND ROW(NEW.id,NEW.organization_id,NEW.recipient_id,NEW.kind,NEW.event_id,NEW.target_id,NEW.created_at) IS DISTINCT FROM ROW(OLD.id,OLD.organization_id,OLD.recipient_id,OLD.kind,OLD.event_id,OLD.target_id,OLD.created_at)
 THEN RAISE EXCEPTION 'ledger integrity notice receipt identity is immutable';END IF;
 IF NEW.kind<>'ledger_integrity_failed' THEN RETURN NEW;END IF;
 SELECT * INTO event_row FROM outbox_event WHERE organization_id=NEW.organization_id AND id=NEW.event_id;
 IF event_row.id IS NULL OR event_row.type<>'notification.requested' OR event_row.payload->>'kind' IS DISTINCT FROM NEW.kind
  OR event_row.id IS DISTINCT FROM NEW.target_id OR event_row.payload->>'recipientId' IS DISTINCT FROM NEW.recipient_id::text
  OR event_row.payload->>'targetId' IS DISTINCT FROM NEW.target_id::text OR NEW.created_at IS DISTINCT FROM event_row.occurred_at
 THEN RAISE EXCEPTION 'ledger integrity notice receipt requires its actual immutable source event';END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER ledger_integrity_notice_receipt_guard BEFORE INSERT OR UPDATE OR DELETE ON notification
 FOR EACH ROW EXECUTE FUNCTION app_ledger_integrity_notice_receipt_guard();
COMMIT;
