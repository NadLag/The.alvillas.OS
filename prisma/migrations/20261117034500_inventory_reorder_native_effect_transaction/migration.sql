-- The existing automation action savepoint assigns its own subtransaction ID.
-- Bind the immutable effect, successful run and attributed audit to that same
-- actual transaction; a previously committed run or audit cannot prove a new effect.
CREATE OR REPLACE FUNCTION app_inventory_reorder_suggestion_complete() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE signal jsonb; source_event uuid; event_payload jsonb; effect_xmin text;
BEGIN
 IF NEW.native_source IS NULL THEN RETURN NULL;END IF;
 SELECT xmin::text INTO effect_xmin FROM automation_suggestion WHERE organization_id=NEW.organization_id AND id=NEW.id;
 IF NOT FOUND THEN RAISE EXCEPTION 'inventory suggestion original effect required';END IF;
 signal:=NEW.native_source->'signal';source_event:=(NEW.native_source->>'eventId')::uuid;
 SELECT payload INTO event_payload FROM outbox_event WHERE organization_id=NEW.organization_id AND id=source_event AND type='InventoryBelowMinimum';
 IF NOT FOUND OR event_payload->'inventorySource' IS DISTINCT FROM signal
  OR signal->>'schemaVersion' IS DISTINCT FROM '1' OR signal->>'organizationId' IS DISTINCT FROM NEW.organization_id::text
  OR signal#>>'{location,id}' IS DISTINCT FROM NEW.location_id::text OR signal#>>'{item,id}' IS DISTINCT FROM NEW.item_id::text
  OR signal#>>'{item,key}' IS DISTINCT FROM NEW.item_key OR signal#>>'{location,propertyId}' IS DISTINCT FROM NEW.property_id::text
  OR COALESCE(signal->>'suggestedQuantity','')!~'^[1-9][0-9]{0,62}$' OR(signal->>'suggestedQuantity')::numeric<>NEW.quantity
 THEN RAISE EXCEPTION 'inventory suggestion original signal required';END IF;
 IF NOT EXISTS(SELECT 1 FROM automation_run r CROSS JOIN LATERAL jsonb_array_elements(r.outputs) outcome
   WHERE r.organization_id=NEW.organization_id AND r.event_id=source_event AND r.actor_id=NEW.created_by AND r.status='SUCCEEDED'
    AND r.property_id IS NOT DISTINCT FROM NEW.property_id AND NEW.outcome_key=r.id::text||':'||(outcome->>'key')
    AND outcome->>'type'='reorder_suggestion' AND outcome->'producedIds' @> jsonb_build_array(NEW.id::text)
    AND COALESCE(outcome->>'quantity','')~'^[1-9][0-9]{0,62}$' AND(outcome->>'quantity')::numeric=NEW.quantity
    AND r.xmin::text=effect_xmin)
  OR NOT EXISTS(SELECT 1 FROM audit_log a WHERE a.organization_id=NEW.organization_id AND a.actor_id=NEW.created_by
   AND a.resource_type='inventory_reorder' AND a.resource_id=NEW.id AND a.action='inventory.reorder.suggested'
   AND a.after->>'eventId'=source_event::text AND a.after->>'locationId'=NEW.location_id::text AND a.after->>'itemId'=NEW.item_id::text
   AND a.after->>'quantity'=signal->>'suggestedQuantity' AND a.xmin::text=effect_xmin)
 THEN RAISE EXCEPTION 'inventory suggestion native effect and attributed audit must commit together';END IF;
 RETURN NULL;
END $$;
