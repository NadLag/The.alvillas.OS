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
  -- Native company inventory has an actual immutable location, item and signal.
  -- The original organization invoice admission remains unchanged below.
  IF EXISTS(SELECT 1 FROM config_rule c JOIN outbox_event e ON e.organization_id=c.organization_id
   JOIN inventory_location l ON l.organization_id=e.organization_id AND l.id::text=e.payload#>>'{inventorySource,location,id}'
   JOIN inventory_item i ON i.organization_id=l.organization_id AND i.id::text=e.payload#>>'{inventorySource,item,id}'
   WHERE c.organization_id=NEW.organization_id AND c.id=NEW.config_rule_id AND c.key=NEW.rule_key
    AND c.scope_type='organization' AND c.scope_id IS NULL AND c.created_by=NEW.actor_id AND e.id=NEW.event_id
    AND e.type='InventoryBelowMinimum' AND e.payload#>>'{inventorySource,schemaVersion}'='1'
    AND e.payload#>>'{inventorySource,organizationId}'=NEW.organization_id::text
    AND l.property_id IS NULL AND e.payload#>>'{inventorySource,location,propertyId}' IS NULL
    AND e.idempotency_key='inventory-below-minimum:'||l.id::text||':'||i.id::text||':'||(e.payload#>>'{inventorySource,position,revision}')||':'||(e.payload#>>'{inventorySource,minimumRule,id}'))
   THEN RETURN NEW;END IF;
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

