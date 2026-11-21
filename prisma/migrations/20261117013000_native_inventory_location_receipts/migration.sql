-- Preserve native locations and all original movements. Only new command
-- acknowledgements are admitted here; queue delivery fields remain mutable.
CREATE FUNCTION app_guard_inventory_location_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN
  IF OLD.type IN('inventory.location.changed','inventory.location.cancelled') THEN RAISE EXCEPTION 'inventory_location_receipt_immutable';END IF;
  RETURN OLD;
 END IF;
 IF TG_OP='UPDATE' THEN
  IF(OLD.type IN('inventory.location.changed','inventory.location.cancelled') OR NEW.type IN('inventory.location.changed','inventory.location.cancelled')) AND
   ROW(OLD.id,OLD.organization_id,OLD.type,OLD.payload,OLD.idempotency_key,OLD.occurred_at,OLD.created_at) IS DISTINCT FROM
   ROW(NEW.id,NEW.organization_id,NEW.type,NEW.payload,NEW.idempotency_key,NEW.occurred_at,NEW.created_at)
  THEN RAISE EXCEPTION 'inventory_location_receipt_immutable';END IF;
  RETURN NEW;
 END IF;
 IF NEW.type='inventory.location.changed' AND NOT EXISTS(
  SELECT 1 FROM inventory_location l JOIN audit_log a ON a.organization_id=l.organization_id AND a.resource_type='inventory_location' AND a.resource_id=l.id
  WHERE l.organization_id=NEW.organization_id AND l.xmin::text=pg_current_xact_id()::xid::text
   AND NEW.status='PENDING' AND NEW.attempt_count=0 AND NEW.processed_at IS NULL AND NEW.next_attempt_at IS NULL AND NEW.last_error IS NULL
   AND NEW.payload->>'schemaVersion'='1' AND NEW.payload->>'organizationId'=l.organization_id::text AND NEW.payload->>'locationId'=l.id::text AND NEW.payload->>'actorId'=a.actor_id::text
   AND NEW.payload->>'operation' IN('CREATE','RENAME','ARCHIVE','RESTORE')
   AND a.action=CASE NEW.payload->>'operation' WHEN 'CREATE' THEN 'inventory.location.created' WHEN 'RENAME' THEN 'inventory.location.renamed' WHEN 'ARCHIVE' THEN 'inventory.location.archived' ELSE 'inventory.location.restored' END
   AND NEW.idempotency_key~'^inventory-location:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
   AND COALESCE(NEW.payload->>'commandHash','')~'^[a-f0-9]{64}$' AND COALESCE(NEW.payload->>'fingerprint','')~'^[a-f0-9]{64}$'
   AND a.after->>'fingerprint'=NEW.payload->>'fingerprint' AND a.after->>'id'=l.id::text AND a.after->>'kind'=l.kind AND a.after->>'label'=l.label
   AND a.after->>'propertyId' IS NOT DISTINCT FROM l.property_id::text AND a.property_scope_id IS NOT DISTINCT FROM l.property_id
   AND (NEW.payload->>'operation'='ARCHIVE')=(l.archived_at IS NOT NULL)
   AND length(btrim(a.reason)) BETWEEN 6 AND 500 AND NEW.occurred_at=a.occurred_at AND a.xmin::text=pg_current_xact_id()::xid::text)
 THEN RAISE EXCEPTION 'inventory_location_receipt_requires_original_attributed_audit';END IF;
 IF NEW.type='inventory.location.cancelled' AND NOT EXISTS(
  SELECT 1 FROM audit_log a WHERE a.organization_id=NEW.organization_id AND a.resource_type='inventory_location_command'
   AND NEW.idempotency_key='inventory-location:'||a.resource_id::text AND a.action='inventory.location.cancelled'
   AND NEW.payload=jsonb_build_object('schemaVersion',1,'organizationId',NEW.organization_id::text,'actorId',a.actor_id::text,'idempotencyKey',a.resource_id::text)
   AND a.after=NEW.payload AND NEW.occurred_at=a.occurred_at AND a.xmin::text=pg_current_xact_id()::xid::text
   AND NEW.status='PENDING' AND NEW.attempt_count=0 AND NEW.processed_at IS NULL AND NEW.next_attempt_at IS NULL AND NEW.last_error IS NULL)
 THEN RAISE EXCEPTION 'inventory_location_cancellation_requires_original_attributed_audit';END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER inventory_location_receipt_guard BEFORE INSERT OR UPDATE OR DELETE ON outbox_event FOR EACH ROW EXECUTE FUNCTION app_guard_inventory_location_receipt();
