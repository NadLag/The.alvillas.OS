-- Extend the original observation stream without changing any existing row or field-device contract.
CREATE INDEX inventory_stocktake_native_history_idx ON inventory_stocktake(organization_id,received_at DESC,id DESC);

CREATE FUNCTION app_inventory_workspace_count_complete() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE original_xid xid; location_property uuid;
BEGIN
 IF NEW.device_id NOT LIKE 'inventory-workspace:%' AND NEW.config_snapshot->>'origin' IS DISTINCT FROM 'INVENTORY_WORKSPACE' THEN RETURN NULL; END IF;
 SELECT xmin INTO original_xid FROM inventory_stocktake WHERE organization_id=NEW.organization_id AND id=NEW.id;
 SELECT property_id INTO location_property FROM inventory_location WHERE organization_id=NEW.organization_id AND id=NEW.location_id;
 IF NEW.device_id<>'inventory-workspace:'||NEW.actor_id::text OR NEW.property_id IS DISTINCT FROM location_property
  OR NEW.task_id IS NOT NULL OR NEW.config_rule_id IS NOT NULL OR NEW.client_created_at IS NOT NULL
  OR NEW.config_snapshot->>'origin' IS DISTINCT FROM 'INVENTORY_WORKSPACE'
  OR NEW.config_snapshot->>'schemaVersion' IS DISTINCT FROM '1'
  OR NEW.config_snapshot->>'actorId' IS DISTINCT FROM NEW.actor_id::text
  OR NEW.config_snapshot#>>'{command,idempotencyKey}' IS DISTINCT FROM NEW.client_op_id::text
  OR NEW.config_snapshot#>>'{command,draft,itemId}' IS DISTINCT FROM NEW.item_id::text
  OR NEW.config_snapshot#>>'{command,draft,locationId}' IS DISTINCT FROM NEW.location_id::text
  OR NEW.config_snapshot#>>'{command,draft,countedQuantity}' IS DISTINCT FROM NEW.counted_quantity::text
  OR NEW.config_snapshot#>>'{command,draft,expected,quantity}' IS DISTINCT FROM NEW.expected_quantity::text
  OR NEW.config_snapshot#>>'{command,draft,expected,revision}' IS DISTINCT FROM NEW.expected_revision::text
  OR NEW.config_snapshot#>>'{command,draft,reason}' IS DISTINCT FROM NEW.note
 THEN RAISE EXCEPTION 'inventory_workspace_count_original_source_required'; END IF;
 IF NOT EXISTS(SELECT 1 FROM audit_log a WHERE a.organization_id=NEW.organization_id AND a.resource_id=NEW.id AND a.resource_type='inventory_stocktake'
  AND a.action='inventory.stocktake.record' AND a.actor_id=NEW.actor_id AND a.property_scope_id IS NOT DISTINCT FROM NEW.property_id AND a.xmin=original_xid)
 OR NOT EXISTS(SELECT 1 FROM outbox_event e WHERE e.organization_id=NEW.organization_id AND e.type='inventory.stocktake.published'
  AND e.idempotency_key='inventory-stocktake:'||NEW.client_op_id::text AND e.xmin=original_xid
  AND e.payload->>'organizationId'=NEW.organization_id::text AND e.payload->>'actorId'=NEW.actor_id::text
  AND e.payload->>'schemaVersion'='1' AND e.payload->>'idempotencyKey'=NEW.client_op_id::text
  AND e.payload->>'stocktakeId'=NEW.id::text AND e.payload->>'revision'=NEW.revision::text
  AND e.payload->'draft'=NEW.config_snapshot#>'{command,draft}'
  AND e.payload->>'reviewFingerprint'=NEW.config_snapshot#>>'{command,reviewFingerprint}'
  AND e.occurred_at=NEW.received_at
  AND (e.payload->>'movementId') IS NOT DISTINCT FROM(SELECT m.id::text FROM inventory_movement m WHERE m.organization_id=NEW.organization_id AND m.stocktake_id=NEW.id))
 THEN RAISE EXCEPTION 'inventory_workspace_count_atomic_receipt_and_audit_required'; END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER inventory_workspace_count_complete AFTER INSERT ON inventory_stocktake
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app_inventory_workspace_count_complete();

CREATE FUNCTION app_inventory_workspace_count_event_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE observation inventory_stocktake;
BEGIN
 IF TG_OP<>'INSERT' THEN
  IF OLD.type NOT IN('inventory.stocktake.published','inventory.stocktake.cancelled') AND OLD.idempotency_key NOT LIKE 'inventory-stocktake:%'
   AND(TG_OP='DELETE' OR NEW.type NOT IN('inventory.stocktake.published','inventory.stocktake.cancelled') AND NEW.idempotency_key NOT LIKE 'inventory-stocktake:%') THEN
   IF TG_OP='DELETE' THEN RETURN OLD; END IF; RETURN NEW;
  END IF;
  IF TG_OP='DELETE' OR ROW(NEW.id,NEW.organization_id,NEW.type,NEW.payload,NEW.idempotency_key,NEW.occurred_at,NEW.created_at)
   IS DISTINCT FROM ROW(OLD.id,OLD.organization_id,OLD.type,OLD.payload,OLD.idempotency_key,OLD.occurred_at,OLD.created_at)
  THEN RAISE EXCEPTION 'inventory_workspace_count_receipt_immutable'; END IF;
  RETURN NEW;
 END IF;
 IF NEW.type NOT IN('inventory.stocktake.published','inventory.stocktake.cancelled') AND NEW.idempotency_key NOT LIKE 'inventory-stocktake:%' THEN RETURN NEW; END IF;
 IF NEW.payload->>'organizationId' IS DISTINCT FROM NEW.organization_id::text OR NEW.payload->>'schemaVersion' IS DISTINCT FROM '1'
  OR NEW.idempotency_key IS DISTINCT FROM 'inventory-stocktake:'||(NEW.payload->>'idempotencyKey')
 THEN RAISE EXCEPTION 'inventory_workspace_count_receipt_source_required'; END IF;
 IF NEW.type='inventory.stocktake.published' THEN
  SELECT * INTO observation FROM inventory_stocktake WHERE organization_id=NEW.organization_id AND id::text=NEW.payload->>'stocktakeId';
  IF NOT FOUND OR observation.device_id<>'inventory-workspace:'||observation.actor_id::text
   OR NEW.payload->>'actorId' IS DISTINCT FROM observation.actor_id::text
   OR NEW.payload->>'idempotencyKey' IS DISTINCT FROM observation.client_op_id::text
   OR NEW.payload->'draft' IS DISTINCT FROM observation.config_snapshot#>'{command,draft}'
  THEN RAISE EXCEPTION 'inventory_workspace_count_receipt_source_required'; END IF;
 ELSIF NEW.type='inventory.stocktake.cancelled' THEN
  IF NOT EXISTS(SELECT 1 FROM audit_log a WHERE a.organization_id=NEW.organization_id AND a.action=NEW.type
   AND a.resource_type='inventory_stocktake_command' AND a.resource_id::text=NEW.payload->>'idempotencyKey'
   AND a.actor_id::text=NEW.payload->>'actorId' AND a.after=NEW.payload AND a.xmin::text=pg_current_xact_id()::text)
  THEN RAISE EXCEPTION 'inventory_workspace_count_cancellation_audit_required'; END IF;
 ELSE RAISE EXCEPTION 'inventory_workspace_count_receipt_type_required'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER inventory_workspace_count_event_guard BEFORE INSERT OR UPDATE OR DELETE ON outbox_event
 FOR EACH ROW EXECUTE FUNCTION app_inventory_workspace_count_event_guard();
