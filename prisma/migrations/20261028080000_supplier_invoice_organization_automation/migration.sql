BEGIN;

ALTER TABLE automation_run ALTER COLUMN property_id DROP NOT NULL;
CREATE UNIQUE INDEX automation_run_organization_event_unique
 ON automation_run(organization_id,rule_key,event_key) WHERE property_id IS NULL;

-- Existing property runs retain their original reference checks. An organization
-- run must instead refer to an actual immutable invoice submission event.
CREATE OR REPLACE FUNCTION app_check_automation_tenant() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM user_account WHERE id=NEW.actor_id AND organization_id=NEW.organization_id)
 OR NOT EXISTS(SELECT 1 FROM config_rule WHERE id=NEW.config_rule_id AND organization_id=NEW.organization_id)
 OR NOT EXISTS(SELECT 1 FROM outbox_event WHERE id=NEW.event_id AND organization_id=NEW.organization_id)
 THEN RAISE EXCEPTION 'automation tenant reference mismatch'; END IF;
 IF NEW.property_id IS NOT NULL THEN
  IF NOT EXISTS(SELECT 1 FROM property WHERE id=NEW.property_id AND organization_id=NEW.organization_id)
   THEN RAISE EXCEPTION 'automation tenant reference mismatch'; END IF;
 ELSE
  IF NOT EXISTS(SELECT 1 FROM config_rule c JOIN outbox_event e ON e.organization_id=c.organization_id
   JOIN supplier_invoice_submission s ON s.organization_id=e.organization_id
   LEFT JOIN approval_request a ON a.organization_id=s.organization_id AND a.invoice_submission_id=s.id
   WHERE c.organization_id=NEW.organization_id AND c.id=NEW.config_rule_id AND c.key=NEW.rule_key
    AND c.scope_type='organization' AND c.scope_id IS NULL AND c.created_by=NEW.actor_id AND e.id=NEW.event_id
    AND ((e.type='SupplierInvoiceSubmitted' AND e.payload->>'submissionId'=s.id::text AND e.payload->>'invoiceId'=s.invoice_id::text
      AND e.idempotency_key='supplier-invoice:'||s.id::text||':SupplierInvoiceSubmitted')
     OR (e.type IN ('ApprovalRequested','ApprovalDecided') AND e.payload->>'approvalId'=a.id::text
      AND e.idempotency_key='approval:'||a.id::text||':'||e.type)))
   THEN RAISE EXCEPTION 'organization automation requires its actual invoice event and rule principal'; END IF;
 END IF;
 RETURN NEW;
END $$;

CREATE FUNCTION app_invoice_business_event_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE s supplier_invoice_submission%ROWTYPE; a approval_request%ROWTYPE; old_bound boolean := false; new_bound boolean := false;
BEGIN
 IF TG_OP<>'INSERT' THEN
  old_bound := OLD.type='SupplierInvoiceSubmitted' OR (OLD.type IN ('ApprovalRequested','ApprovalDecided') AND EXISTS (
   SELECT 1 FROM approval_request WHERE organization_id=OLD.organization_id AND id::text=OLD.payload->>'approvalId' AND invoice_submission_id IS NOT NULL));
  IF old_bound AND (TG_OP='DELETE' OR ROW(NEW.organization_id,NEW.id,NEW.type,NEW.payload,NEW.idempotency_key,NEW.occurred_at)
   IS DISTINCT FROM ROW(OLD.organization_id,OLD.id,OLD.type,OLD.payload,OLD.idempotency_key,OLD.occurred_at))
   THEN RAISE EXCEPTION 'supplier invoice business event source facts are immutable'; END IF;
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 IF NEW.type='SupplierInvoiceSubmitted' THEN
  SELECT * INTO s FROM supplier_invoice_submission WHERE organization_id=NEW.organization_id AND id::text=NEW.payload->>'submissionId';
  IF s.id IS NULL OR NEW.payload->>'invoiceId' IS DISTINCT FROM s.invoice_id::text
   OR NEW.idempotency_key IS DISTINCT FROM 'supplier-invoice:'||s.id::text||':SupplierInvoiceSubmitted'
   OR NEW.occurred_at IS DISTINCT FROM s.submitted_at OR (NEW.payload-'invoiceId'-'submissionId'-'automationPath')<>'{}'::jsonb
   THEN RAISE EXCEPTION 'supplier invoice business event requires its canonical immutable source'; END IF;
  new_bound := true;
 ELSIF NEW.type IN ('ApprovalRequested','ApprovalDecided') THEN
  SELECT * INTO a FROM approval_request WHERE organization_id=NEW.organization_id AND id::text=NEW.payload->>'approvalId' AND invoice_submission_id IS NOT NULL;
  IF a.id IS NOT NULL THEN
   IF a.property_id IS NOT NULL OR NEW.idempotency_key IS DISTINCT FROM 'approval:'||a.id::text||':'||NEW.type
    OR (NEW.payload-'approvalId'-'automationPath')<>'{}'::jsonb
    OR NOT EXISTS(SELECT 1 FROM supplier_invoice_submission WHERE organization_id=NEW.organization_id AND id=a.invoice_submission_id)
    OR (TG_OP='INSERT' AND NEW.type='ApprovalDecided' AND a.state NOT IN ('APPROVED','REJECTED'))
    THEN RAISE EXCEPTION 'invoice approval business event requires its actual organization source'; END IF;
   new_bound := true;
  END IF;
 END IF;
 IF TG_OP='UPDATE' AND new_bound AND NOT old_bound
  THEN RAISE EXCEPTION 'an existing business event cannot acquire an invoice source'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER outbox_invoice_business_source_guard BEFORE INSERT OR UPDATE OR DELETE ON outbox_event
 FOR EACH ROW EXECUTE FUNCTION app_invoice_business_event_guard();

-- This deferred check complements the existing complete source/approval/audit
-- assertion. Both must pass at commit; neither changes historical source rows.
CREATE FUNCTION app_invoice_submitted_event_required() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM outbox_event e WHERE e.organization_id=NEW.organization_id AND e.type='SupplierInvoiceSubmitted'
  AND e.idempotency_key='supplier-invoice:'||NEW.id::text||':SupplierInvoiceSubmitted'
  AND e.payload->>'submissionId'=NEW.id::text AND e.payload->>'invoiceId'=NEW.invoice_id::text AND e.occurred_at=NEW.submitted_at)
  THEN RAISE EXCEPTION 'supplier invoice submission requires its canonical business event'; END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER supplier_invoice_submitted_event_required AFTER INSERT ON supplier_invoice_submission
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app_invoice_submitted_event_required();

COMMIT;
