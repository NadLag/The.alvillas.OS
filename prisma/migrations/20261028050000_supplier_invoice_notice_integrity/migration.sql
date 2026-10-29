BEGIN;
-- Complete invoice source adapters without changing any applied migration or historical row.
CREATE OR REPLACE FUNCTION app_validate_approval_property() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.invoice_submission_id IS NOT NULL THEN
  IF NEW.property_id IS NOT NULL OR NOT EXISTS (SELECT 1 FROM supplier_invoice_submission s WHERE s.organization_id=NEW.organization_id AND s.id=NEW.invoice_submission_id)
   THEN RAISE EXCEPTION 'approval invoice source tenant mismatch'; END IF;
 ELSIF NOT EXISTS (SELECT 1 FROM property WHERE id=NEW.property_id AND organization_id=NEW.organization_id)
  THEN RAISE EXCEPTION 'approval property tenant mismatch'; END IF;
 RETURN NEW;
END; $$;

-- Top-level source guards validate complete counts at commit. Row guards below
-- validate only their frozen member, avoiding a full source scan for every row.
DROP TRIGGER supplier_invoice_stage_integrity ON approval_stage;
DROP TRIGGER supplier_invoice_audience_integrity ON approval_recipient;
DROP TRIGGER supplier_invoice_stage_audience_integrity ON approval_stage_recipient;

CREATE OR REPLACE FUNCTION app_invoice_approval_stage_source_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE a approval_request%ROWTYPE; s supplier_invoice_submission%ROWTYPE; l supplier_invoice_line%ROWTYPE; source_line jsonb; expected jsonb;
BEGIN
 SELECT * INTO a FROM approval_request WHERE organization_id=NEW.organization_id AND id=NEW.approval_id;
 IF a.invoice_submission_id IS NULL THEN
  IF NEW.invoice_line_id IS NOT NULL OR NEW.property_id IS NOT NULL OR NEW.reservation_id IS NOT NULL OR NEW.source_snapshot IS NOT NULL
   THEN RAISE EXCEPTION 'non-invoice approval cannot adopt an invoice source'; END IF;
  RETURN NEW;
 END IF;
 IF TG_OP='UPDATE' AND ROW(NEW.invoice_line_id,NEW.property_id,NEW.reservation_id,NEW.source_snapshot)
  IS DISTINCT FROM ROW(OLD.invoice_line_id,OLD.property_id,OLD.reservation_id,OLD.source_snapshot) THEN RAISE EXCEPTION 'invoice approval stage source is immutable'; END IF;
 SELECT * INTO s FROM supplier_invoice_submission WHERE organization_id=NEW.organization_id AND id=a.invoice_submission_id;
 SELECT * INTO l FROM supplier_invoice_line WHERE organization_id=NEW.organization_id AND id=NEW.invoice_line_id;
 SELECT x INTO source_line FROM jsonb_array_elements(s.snapshot->'lines') x WHERE x->>'id'=l.id::text;
 expected=s.snapshot->'stages'->(NEW.position-1);
 IF l.id IS NULL OR l.revision_id<>s.revision_id OR l.property_id IS DISTINCT FROM NEW.property_id OR l.reservation_id IS DISTINCT FROM NEW.reservation_id
  OR NEW.source_snapshot IS NULL OR NEW.source_snapshot->>'lineId' IS DISTINCT FROM l.id::text OR NEW.source_snapshot->>'category' IS DISTINCT FROM l.category
  OR NEW.source_snapshot->>'occurredOn' IS DISTINCT FROM s.occurred_on::text OR COALESCE(length(btrim(NEW.source_snapshot->>'note')),0) NOT BETWEEN 6 AND 1000
  OR NEW.source_snapshot->>'note' IS DISTINCT FROM source_line->>'approvalNote' OR NEW.source_snapshot->>'timezone' IS DISTINCT FROM source_line->'policy'->>'timezone'
  OR expected IS NULL OR NEW.kind IS DISTINCT FROM expected->>'kind' OR NEW.owner_id::text IS DISTINCT FROM expected->>'ownerId'
  OR NEW.amount IS DISTINCT FROM (expected->>'amount')::numeric OR NEW.currency IS DISTINCT FROM expected->>'currency'
  OR NEW.invoice_line_id::text IS DISTINCT FROM expected->>'lineId' OR NEW.property_id::text IS DISTINCT FROM expected->>'propertyId'
  OR NEW.reservation_id::text IS DISTINCT FROM expected->>'reservationId' OR NEW.routing_snapshot IS DISTINCT FROM expected->'routing'
  OR NEW.source_snapshot IS DISTINCT FROM expected->'sourceSnapshot'
  THEN RAISE EXCEPTION 'invoice approval stage requires its exact frozen cost policy'; END IF;
 RETURN NEW;
END; $$;

CREATE FUNCTION app_invoice_frozen_audience_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE a approval_request%ROWTYPE; s supplier_invoice_submission%ROWTYPE; stage approval_stage%ROWTYPE; expected jsonb; allowed boolean;
BEGIN
 IF TG_TABLE_NAME='approval_stage_recipient' THEN
  SELECT * INTO stage FROM approval_stage WHERE organization_id=NEW.organization_id AND id=NEW.stage_id;
  SELECT * INTO a FROM approval_request WHERE organization_id=NEW.organization_id AND id=stage.approval_id;
 ELSE SELECT * INTO a FROM approval_request WHERE organization_id=NEW.organization_id AND id=NEW.approval_id; END IF;
 IF a.invoice_submission_id IS NULL THEN RETURN NEW; END IF;
 SELECT * INTO s FROM supplier_invoice_submission WHERE organization_id=NEW.organization_id AND id=a.invoice_submission_id;
 IF TG_TABLE_NAME='approval_stage_recipient' THEN
  expected=s.snapshot->'stages'->(stage.position-1);
  allowed=(expected->'recipients') @> jsonb_build_array(NEW.user_account_id::text);
 ELSE
  SELECT EXISTS (SELECT 1 FROM jsonb_array_elements(s.snapshot->'stages') x WHERE x->'recipients' @> jsonb_build_array(NEW.user_account_id::text)) INTO allowed;
 END IF;
 IF allowed IS DISTINCT FROM true THEN RAISE EXCEPTION 'supplier invoice approval audience must match its frozen policy'; END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER supplier_invoice_stage_audience_frozen BEFORE INSERT ON approval_stage_recipient FOR EACH ROW EXECUTE FUNCTION app_invoice_frozen_audience_guard();
CREATE TRIGGER supplier_invoice_audience_frozen BEFORE INSERT ON approval_recipient FOR EACH ROW EXECUTE FUNCTION app_invoice_frozen_audience_guard();

CREATE FUNCTION app_assert_invoice_approval_fold(org_uuid uuid,source_uuid uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE s supplier_invoice_submission%ROWTYPE; i supplier_invoice%ROWTYPE; a approval_request%ROWTYPE; folded text; approved_count bigint; rejected_count bigint; pending_count bigint; total bigint;
BEGIN
 SELECT * INTO s FROM supplier_invoice_submission WHERE organization_id=org_uuid AND id=source_uuid;
 SELECT * INTO i FROM supplier_invoice WHERE organization_id=org_uuid AND id=s.invoice_id;
 SELECT * INTO a FROM approval_request WHERE organization_id=org_uuid AND invoice_submission_id=s.id;
 IF s.id IS NULL OR i.current_submission_id IS DISTINCT FROM s.id THEN RAISE EXCEPTION 'invoice approval requires its current submitted source'; END IF;
 IF jsonb_array_length(s.snapshot->'stages')=0 THEN RETURN; END IF;
 SELECT count(*),count(*) FILTER (WHERE state='APPROVED'),count(*) FILTER (WHERE state='REJECTED'),count(*) FILTER (WHERE state='PENDING')
  INTO total,approved_count,rejected_count,pending_count FROM approval_stage WHERE organization_id=org_uuid AND approval_id=a.id;
 folded=CASE WHEN rejected_count>0 THEN 'REJECTED' WHEN total>0 AND approved_count=total THEN 'APPROVED' ELSE 'PENDING' END;
 IF a.id IS NULL OR a.state IS DISTINCT FROM folded OR i.state IS DISTINCT FROM (CASE WHEN folded='PENDING' THEN 'PENDING_APPROVAL' ELSE folded END)
   OR (folded<>'PENDING' AND pending_count>0) THEN RAISE EXCEPTION 'invoice approval and source must reflect their configured stage decisions'; END IF;
END; $$;

CREATE FUNCTION app_invoice_stage_decision_integrity_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE a approval_request%ROWTYPE; s supplier_invoice_submission%ROWTYPE; stage approval_stage%ROWTYPE;
BEGIN
 SELECT * INTO a FROM approval_request WHERE organization_id=NEW.organization_id AND id=NEW.approval_id;
 IF a.invoice_submission_id IS NULL THEN RETURN NEW; END IF;
 SELECT * INTO s FROM supplier_invoice_submission WHERE organization_id=NEW.organization_id AND id=a.invoice_submission_id;
 SELECT * INTO stage FROM approval_stage WHERE organization_id=NEW.organization_id AND id=NEW.id;
 IF stage.state IN ('APPROVED','REJECTED') AND NOT EXISTS (SELECT 1 FROM audit_log x WHERE x.organization_id=NEW.organization_id AND x.resource_type='supplier_invoice'
   AND x.resource_id=s.invoice_id AND x.action='finance.supplier_invoice.approval_stage_decided' AND x.actor_id=stage.decided_by AND x.reason=stage.decision_reason
   AND x.after->>'stageId'=stage.id::text AND x.after->>'state'=stage.state AND x.after->>'lineId'=stage.invoice_line_id::text
   AND (x.after->>'amount')::numeric=stage.amount AND x.after->>'currency'=stage.currency)
  THEN RAISE EXCEPTION 'invoice approval decision requires its exact attributed source audit'; END IF;
 PERFORM app_assert_invoice_approval_fold(NEW.organization_id,s.id); RETURN NEW;
END; $$;
CREATE CONSTRAINT TRIGGER supplier_invoice_stage_decision_integrity AFTER UPDATE ON approval_stage DEFERRABLE INITIALLY DEFERRED
 FOR EACH ROW EXECUTE FUNCTION app_invoice_stage_decision_integrity_guard();

CREATE FUNCTION app_invoice_emergency_envelope_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE event_row outbox_event%ROWTYPE; s supplier_invoice_submission%ROWTYPE; notice jsonb; recipient_uuid uuid; line_uuid uuid; owner_uuid uuid; source_uuid uuid; valid boolean;
BEGIN
 IF TG_OP='DELETE' THEN
  IF OLD.type='notification.requested' AND OLD.payload->>'kind'='supplier_invoice_emergency' THEN RAISE EXCEPTION 'financial invoice notice source events are append-only'; END IF;
  RETURN OLD;
 END IF;
 IF TG_OP='UPDATE' AND ((OLD.type='notification.requested' AND OLD.payload->>'kind'='supplier_invoice_emergency') OR (NEW.type='notification.requested' AND NEW.payload->>'kind'='supplier_invoice_emergency'))
  AND ROW(NEW.id,NEW.organization_id,NEW.type,NEW.payload,NEW.idempotency_key,NEW.occurred_at)
    IS DISTINCT FROM ROW(OLD.id,OLD.organization_id,OLD.type,OLD.payload,OLD.idempotency_key,OLD.occurred_at)
  THEN RAISE EXCEPTION 'financial invoice notice source identity is immutable'; END IF;
 IF NEW.type<>'notification.requested' OR NEW.payload->>'kind' IS DISTINCT FROM 'supplier_invoice_emergency' THEN RETURN NEW; END IF;
 source_uuid=(NEW.payload->'invoiceNotice'->>'submissionId')::uuid; line_uuid=(NEW.payload->'invoiceNotice'->>'lineId')::uuid;
 owner_uuid=(NEW.payload->'invoiceNotice'->>'ownerId')::uuid; recipient_uuid=(NEW.payload->>'recipientId')::uuid;
 SELECT * INTO s FROM supplier_invoice_submission WHERE organization_id=NEW.organization_id AND id=source_uuid;
 SELECT EXISTS (SELECT 1 FROM jsonb_array_elements(s.snapshot->'postHocNotices') x WHERE x->>'lineId'=line_uuid::text AND x->>'ownerId'=owner_uuid::text
   AND x->'recipients' @> jsonb_build_array(recipient_uuid::text) AND x->'routing'->'channels' @> '["in_app"]'::jsonb) INTO valid;
 IF s.id IS NULL OR valid IS DISTINCT FROM true OR NEW.payload->>'targetId' IS DISTINCT FROM NEW.id::text OR recipient_uuid IS NULL
  OR NEW.idempotency_key IS DISTINCT FROM 'supplier-invoice:'||s.id::text||':emergency:'||line_uuid::text||':'||owner_uuid::text||':'||recipient_uuid::text
  THEN RAISE EXCEPTION 'financial invoice notice requires its exact frozen recipient and actual source event'; END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER supplier_invoice_emergency_envelope_guard BEFORE INSERT OR UPDATE OR DELETE ON outbox_event FOR EACH ROW EXECUTE FUNCTION app_invoice_emergency_envelope_guard();

CREATE FUNCTION app_invoice_emergency_receipt_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE e outbox_event%ROWTYPE;
BEGIN
 IF TG_OP='DELETE' THEN
  IF OLD.kind='supplier_invoice_emergency' THEN RAISE EXCEPTION 'financial invoice notice receipts are append-only'; END IF;
  RETURN OLD;
 END IF;
 IF TG_OP='UPDATE' AND (OLD.kind='supplier_invoice_emergency' OR NEW.kind='supplier_invoice_emergency')
  AND ROW(NEW.id,NEW.organization_id,NEW.recipient_id,NEW.kind,NEW.event_id,NEW.target_id,NEW.created_at)
    IS DISTINCT FROM ROW(OLD.id,OLD.organization_id,OLD.recipient_id,OLD.kind,OLD.event_id,OLD.target_id,OLD.created_at)
  THEN RAISE EXCEPTION 'financial invoice notice receipt identity is immutable'; END IF;
 IF NEW.kind<>'supplier_invoice_emergency' THEN RETURN NEW; END IF;
 SELECT * INTO e FROM outbox_event WHERE organization_id=NEW.organization_id AND id=NEW.event_id;
 IF e.id IS NULL OR e.type<>'notification.requested' OR e.payload->>'kind' IS DISTINCT FROM NEW.kind OR e.id IS DISTINCT FROM NEW.target_id
  OR e.payload->>'recipientId' IS DISTINCT FROM NEW.recipient_id::text OR e.payload->>'targetId' IS DISTINCT FROM NEW.target_id::text
  THEN RAISE EXCEPTION 'financial invoice notice receipt requires its actual immutable source event'; END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER supplier_invoice_emergency_receipt_guard BEFORE INSERT OR UPDATE OR DELETE ON notification FOR EACH ROW EXECUTE FUNCTION app_invoice_emergency_receipt_guard();

CREATE FUNCTION app_invoice_submission_finish_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE source_uuid uuid; s supplier_invoice_submission%ROWTYPE; notice jsonb; owner_id text; line_id text;
BEGIN
 IF TG_TABLE_NAME='supplier_invoice_submission' THEN source_uuid=NEW.id;
 ELSIF TG_TABLE_NAME='supplier_invoice' THEN source_uuid=NEW.current_submission_id;
 ELSE source_uuid=NEW.invoice_submission_id; END IF;
 IF source_uuid IS NULL THEN RETURN NEW; END IF;
 SELECT * INTO s FROM supplier_invoice_submission WHERE organization_id=NEW.organization_id AND id=source_uuid;
 PERFORM app_assert_invoice_approval_fold(NEW.organization_id,s.id);
 IF jsonb_typeof(s.snapshot->'postHocNotices') IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'invoice submission requires its configured owner notice evidence'; END IF;
 FOR notice IN SELECT value FROM jsonb_array_elements(s.snapshot->'postHocNotices') LOOP
  owner_id=notice->>'ownerId'; line_id=notice->>'lineId';
  IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements_text(notice->'recipients') recipient
    JOIN outbox_event e ON e.organization_id=NEW.organization_id AND e.idempotency_key='supplier-invoice:'||s.id::text||':emergency:'||line_id||':'||owner_id||':'||recipient
    JOIN notification n ON n.organization_id=e.organization_id AND n.event_id=e.id AND n.target_id=e.id AND n.recipient_id::text=recipient AND n.kind='supplier_invoice_emergency'
    WHERE e.type='notification.requested' AND e.payload->>'kind'='supplier_invoice_emergency' AND e.payload->'invoiceNotice'->>'submissionId'=s.id::text
      AND e.payload->'invoiceNotice'->>'lineId'=line_id AND e.payload->'invoiceNotice'->>'ownerId'=owner_id AND e.payload->>'recipientId'=recipient)
   THEN RAISE EXCEPTION 'invoice owner approval bypass requires a durable attributed inbox notice'; END IF;
 END LOOP;
 RETURN NEW;
END; $$;
CREATE CONSTRAINT TRIGGER supplier_invoice_submission_finish AFTER INSERT ON supplier_invoice_submission DEFERRABLE INITIALLY DEFERRED
 FOR EACH ROW EXECUTE FUNCTION app_invoice_submission_finish_guard();
CREATE CONSTRAINT TRIGGER supplier_invoice_header_finish AFTER INSERT OR UPDATE ON supplier_invoice DEFERRABLE INITIALLY DEFERRED
 FOR EACH ROW EXECUTE FUNCTION app_invoice_submission_finish_guard();
CREATE CONSTRAINT TRIGGER supplier_invoice_approval_finish AFTER INSERT OR UPDATE ON approval_request DEFERRABLE INITIALLY DEFERRED
 FOR EACH ROW EXECUTE FUNCTION app_invoice_submission_finish_guard();

COMMIT;
