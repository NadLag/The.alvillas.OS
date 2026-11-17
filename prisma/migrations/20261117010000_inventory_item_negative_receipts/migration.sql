-- A negative acknowledgement fences an original request that arrives late.
-- This is an attributed native command receipt, never an item or stock row.
CREATE FUNCTION app_guard_inventory_item_cancellation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN
  IF OLD.type='inventory.item.cancelled' THEN RAISE EXCEPTION 'inventory_item_cancellation_immutable';END IF;
  RETURN OLD;
 END IF;
 IF TG_OP='UPDATE' THEN
  IF(OLD.type='inventory.item.cancelled' OR NEW.type='inventory.item.cancelled') AND
   ROW(OLD.id,OLD.organization_id,OLD.type,OLD.payload,OLD.idempotency_key,OLD.occurred_at,OLD.created_at) IS DISTINCT FROM
   ROW(NEW.id,NEW.organization_id,NEW.type,NEW.payload,NEW.idempotency_key,NEW.occurred_at,NEW.created_at)
  THEN RAISE EXCEPTION 'inventory_item_cancellation_immutable';END IF;
  RETURN NEW;
 END IF;
 IF NEW.type='inventory.item.cancelled' AND NOT EXISTS(
  SELECT 1 FROM audit_log a
  WHERE a.organization_id=NEW.organization_id AND a.resource_type='inventory_item_command'
   AND NEW.idempotency_key='inventory-item:'||a.resource_id::text AND a.action='inventory.item.cancelled'
   AND NEW.payload=jsonb_build_object('schemaVersion',1,'organizationId',NEW.organization_id::text,'actorId',a.actor_id::text,'idempotencyKey',a.resource_id::text)
   AND a.after=NEW.payload AND NEW.occurred_at=a.occurred_at AND a.xmin::text=pg_current_xact_id()::xid::text
   AND NEW.status='PENDING' AND NEW.attempt_count=0 AND NEW.processed_at IS NULL AND NEW.next_attempt_at IS NULL AND NEW.last_error IS NULL)
 THEN RAISE EXCEPTION 'inventory_item_cancellation_requires_original_attributed_audit';END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER inventory_item_cancellation_guard BEFORE INSERT OR UPDATE OR DELETE ON outbox_event FOR EACH ROW EXECUTE FUNCTION app_guard_inventory_item_cancellation();
