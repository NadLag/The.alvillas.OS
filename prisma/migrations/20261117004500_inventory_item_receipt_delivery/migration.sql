-- Delivery may advance queue state while retaining the immutable command receipt.
CREATE OR REPLACE FUNCTION app_guard_inventory_item_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN
  IF OLD.type='inventory.item.changed' THEN RAISE EXCEPTION 'inventory_item_receipt_immutable';END IF;
  RETURN OLD;
 END IF;
 IF TG_OP='UPDATE' THEN
  IF(OLD.type='inventory.item.changed' OR NEW.type='inventory.item.changed') AND
   ROW(OLD.id,OLD.organization_id,OLD.type,OLD.payload,OLD.idempotency_key,OLD.occurred_at,OLD.created_at) IS DISTINCT FROM
   ROW(NEW.id,NEW.organization_id,NEW.type,NEW.payload,NEW.idempotency_key,NEW.occurred_at,NEW.created_at)
  THEN RAISE EXCEPTION 'inventory_item_receipt_immutable';END IF;
  RETURN NEW;
 END IF;
 IF NEW.type='inventory.item.changed' AND NOT EXISTS(
  SELECT 1 FROM inventory_item i JOIN audit_log a ON a.organization_id=i.organization_id AND a.resource_type='inventory_item' AND a.resource_id=i.id
  WHERE i.organization_id=NEW.organization_id AND NEW.status='PENDING' AND NEW.attempt_count=0 AND NEW.processed_at IS NULL AND NEW.next_attempt_at IS NULL AND NEW.last_error IS NULL AND NEW.payload->>'schemaVersion'='1' AND NEW.payload->>'organizationId'=i.organization_id::text
   AND NEW.payload->>'itemId'=i.id::text AND NEW.payload->>'actorId'=a.actor_id::text
   AND NEW.payload->>'operation' IN('CREATE','RENAME','ARCHIVE','RESTORE')
   AND a.action=CASE NEW.payload->>'operation' WHEN 'CREATE' THEN 'inventory.item.created' WHEN 'RENAME' THEN 'inventory.item.renamed' WHEN 'ARCHIVE' THEN 'inventory.item.archived' ELSE 'inventory.item.restored' END
   AND NEW.idempotency_key~'^inventory-item:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
   AND COALESCE(NEW.payload->>'commandHash','')~'^[a-f0-9]{64}$' AND COALESCE(NEW.payload->>'fingerprint','')~'^[a-f0-9]{64}$'
   AND a.after->>'fingerprint'=NEW.payload->>'fingerprint' AND a.after->>'key'=i.key AND a.after->>'category'=i.category
   AND a.after->>'unit' IS NOT DISTINCT FROM i.unit AND a.after->>'id'=i.id::text
   AND length(btrim(a.reason)) BETWEEN 6 AND 500 AND NEW.occurred_at=a.occurred_at
   AND a.xmin::text=pg_current_xact_id()::xid::text)
 THEN RAISE EXCEPTION 'inventory_item_receipt_requires_original_attributed_audit';END IF;
 RETURN NEW;
END $$;
