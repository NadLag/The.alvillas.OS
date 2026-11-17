-- Reuse immutable operational suggestions. The original decimal scale and
-- every legacy value are preserved when integer capacity is widened.
ALTER TABLE automation_suggestion
 ALTER COLUMN property_id DROP NOT NULL,
 ALTER COLUMN quantity TYPE numeric(65,2),
 ADD COLUMN location_id uuid,
 ADD COLUMN item_id uuid,
 ADD COLUMN native_source jsonb;
ALTER TABLE automation_suggestion ADD CONSTRAINT automation_suggestion_inventory_location_fkey
 FOREIGN KEY(organization_id,location_id) REFERENCES inventory_location(organization_id,id) ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE automation_suggestion ADD CONSTRAINT automation_suggestion_inventory_item_fkey
 FOREIGN KEY(organization_id,item_id) REFERENCES inventory_item(organization_id,id) ON DELETE RESTRICT ON UPDATE NO ACTION;
CREATE INDEX automation_suggestion_inventory_history_idx ON automation_suggestion(organization_id,location_id,item_id,created_at,id);
ALTER TABLE automation_suggestion ADD CONSTRAINT automation_suggestion_inventory_shape CHECK(
 (native_source IS NULL AND location_id IS NULL AND item_id IS NULL AND property_id IS NOT NULL)
 OR(native_source IS NOT NULL AND jsonb_typeof(native_source)='object' AND native_source->>'schemaVersion' IS NOT NULL AND native_source->>'schemaVersion'='1'
  AND location_id IS NOT NULL AND item_id IS NOT NULL AND quantity=trunc(quantity)));

CREATE OR REPLACE FUNCTION app_check_automation_suggestion_tenant() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.property_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM property WHERE id=NEW.property_id AND organization_id=NEW.organization_id)
  OR NEW.property_id IS NULL AND NEW.location_id IS NULL
  OR NOT EXISTS(SELECT 1 FROM user_account WHERE id=NEW.created_by AND organization_id=NEW.organization_id)
 THEN RAISE EXCEPTION 'automation suggestion tenant reference mismatch';END IF;
 IF NEW.native_source IS NOT NULL AND NOT EXISTS(SELECT 1 FROM inventory_location l JOIN inventory_item i ON i.organization_id=l.organization_id
   WHERE l.organization_id=NEW.organization_id AND l.id=NEW.location_id AND i.id=NEW.item_id AND i.key=NEW.item_key
    AND l.property_id IS NOT DISTINCT FROM NEW.property_id)
 THEN RAISE EXCEPTION 'inventory suggestion original location and item required';END IF;
 RETURN NEW;
END $$;

CREATE FUNCTION app_inventory_reorder_suggestion_complete() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE signal jsonb; source_event uuid; event_payload jsonb;
BEGIN
 IF NEW.native_source IS NULL THEN RETURN NULL;END IF;
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
    AND r.xmin::text=pg_current_xact_id()::xid::text)
  OR NOT EXISTS(SELECT 1 FROM audit_log a WHERE a.organization_id=NEW.organization_id AND a.actor_id=NEW.created_by
   AND a.resource_type='inventory_reorder' AND a.resource_id=NEW.id AND a.action='inventory.reorder.suggested'
   AND a.after->>'eventId'=source_event::text AND a.after->>'locationId'=NEW.location_id::text AND a.after->>'itemId'=NEW.item_id::text
   AND a.after->>'quantity'=signal->>'suggestedQuantity' AND a.xmin::text=pg_current_xact_id()::xid::text)
 THEN RAISE EXCEPTION 'inventory suggestion native effect and attributed audit must commit together';END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER inventory_reorder_suggestion_complete AFTER INSERT ON automation_suggestion
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app_inventory_reorder_suggestion_complete();

CREATE FUNCTION app_inventory_reorder_signal_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE signal jsonb; catalog inventory_item; place inventory_location; policy config_rule;
 current_revision bigint; physical numeric; held numeric; damaged numeric; selected_minimum jsonb; entries jsonb;
 current_quantity numeric; threshold numeric; target_quantity numeric; original_actor uuid; original_time timestamptz;
 source_timezone text; timezone_default text;
BEGIN
 IF TG_OP='DELETE' THEN
  IF OLD.type='InventoryBelowMinimum' AND OLD.payload ? 'inventorySource' THEN RAISE EXCEPTION 'inventory reorder source is immutable';END IF;
  RETURN OLD;
 END IF;
 IF TG_OP='UPDATE' THEN
  IF((OLD.type='InventoryBelowMinimum' AND OLD.payload ? 'inventorySource') OR(NEW.type='InventoryBelowMinimum' AND NEW.payload ? 'inventorySource'))
   AND ROW(OLD.id,OLD.organization_id,OLD.type,OLD.payload,OLD.idempotency_key,OLD.occurred_at,OLD.created_at)
    IS DISTINCT FROM ROW(NEW.id,NEW.organization_id,NEW.type,NEW.payload,NEW.idempotency_key,NEW.occurred_at,NEW.created_at)
  THEN RAISE EXCEPTION 'inventory reorder source is immutable';END IF;
  RETURN NEW;
 END IF;
 IF NEW.type<>'InventoryBelowMinimum' OR NOT(NEW.payload ? 'inventorySource') THEN RETURN NEW;END IF;
 IF NEW.status<>'PENDING' OR NEW.attempt_count<>0 OR NEW.processed_at IS NOT NULL
 THEN RAISE EXCEPTION 'inventory reorder signal must enter native pending delivery';END IF;
 signal:=NEW.payload->'inventorySource';
 IF jsonb_typeof(signal) IS DISTINCT FROM 'object' OR signal->>'schemaVersion' IS DISTINCT FROM '1'
  OR signal->>'organizationId' IS DISTINCT FROM NEW.organization_id::text
  OR COALESCE(signal#>>'{source,kind}','') NOT IN('MOVEMENT','STOCKTAKE','CONFIGURATION')
  OR COALESCE(signal->>'basis','') NOT IN('PHYSICAL','AVAILABLE')
 THEN RAISE EXCEPTION 'inventory reorder original source dimensions required';END IF;
 SELECT * INTO catalog FROM inventory_item WHERE organization_id=NEW.organization_id AND id=(signal#>>'{item,id}')::uuid;
 IF NOT FOUND OR catalog.archived_at IS NOT NULL OR signal#>>'{item,key}' IS DISTINCT FROM catalog.key
  OR signal#>>'{item,category}' IS DISTINCT FROM catalog.category OR signal#>>'{item,unit}' IS DISTINCT FROM catalog.unit
 THEN RAISE EXCEPTION 'inventory reorder original item required';END IF;
 SELECT * INTO place FROM inventory_location WHERE organization_id=NEW.organization_id AND id=(signal#>>'{location,id}')::uuid;
 IF NOT FOUND OR place.archived_at IS NOT NULL OR signal#>>'{location,kind}' IS DISTINCT FROM place.kind
  OR signal#>>'{location,propertyId}' IS DISTINCT FROM place.property_id::text OR NEW.payload->>'propertyId' IS DISTINCT FROM place.property_id::text
 THEN RAISE EXCEPTION 'inventory reorder original location required';END IF;
 SELECT COALESCE(sum(quantity_delta),0),COALESCE(sum(reserved_quantity_delta),0),COALESCE(sum(damaged_quantity_delta),0)
  INTO physical,held,damaged FROM inventory_movement WHERE organization_id=NEW.organization_id AND location_id=place.id AND item_id=catalog.id;
 SELECT revision INTO current_revision FROM inventory_stock_cursor WHERE organization_id=NEW.organization_id AND location_id=place.id AND item_id=catalog.id;
 current_revision:=COALESCE(current_revision,0);
 IF signal#>>'{position,quantity}' IS DISTINCT FROM physical::text OR signal#>>'{position,reserved}' IS DISTINCT FROM held::text
  OR signal#>>'{position,damaged}' IS DISTINCT FROM damaged::text OR signal#>>'{position,revision}' IS DISTINCT FROM current_revision::text
 THEN RAISE EXCEPTION 'inventory reorder original stock position required';END IF;
 SELECT * INTO policy FROM config_rule WHERE organization_id=NEW.organization_id AND id=(signal#>>'{minimumRule,id}')::uuid
  AND key='inventory.minimums' AND version=(signal#>>'{minimumRule,version}')::integer AND lifecycle<>'DRAFT'
  AND effective_from<=NEW.occurred_at AND(effective_to IS NULL OR effective_to>NEW.occurred_at);
 IF NOT FOUND OR(policy.scope_type='organization' AND policy.scope_id IS NULL OR policy.scope_type='property' AND policy.scope_id=place.property_id
  OR policy.scope_type='city' AND EXISTS(SELECT 1 FROM property p WHERE p.organization_id=NEW.organization_id AND p.id=place.property_id AND p.city_id=policy.scope_id)
  OR policy.scope_type='agreement' AND EXISTS(SELECT 1 FROM management_agreement a WHERE a.organization_id=NEW.organization_id AND a.id=policy.scope_id
   AND a.property_id=place.property_id AND a.archived_at IS NULL AND a.status<>'DRAFT' AND a.effective_from<=NEW.occurred_at AND(a.effective_to IS NULL OR a.effective_to>NEW.occurred_at))) IS DISTINCT FROM TRUE
 THEN RAISE EXCEPTION 'inventory reorder effective minimum source required';END IF;
 SELECT override->'minimums' INTO entries FROM jsonb_array_elements(policy.value->'location_overrides') override WHERE override->>'location_id'=place.id::text;
 entries:=COALESCE(entries,policy.value->'minimums');
 SELECT item INTO selected_minimum FROM jsonb_array_elements(entries) item WHERE item->>'item'=catalog.key;
 IF NOT FOUND OR(selected_minimum ? 'unit' AND selected_minimum->>'unit' IS DISTINCT FROM catalog.unit)
  OR(selected_minimum ? 'category' AND selected_minimum->>'category' IS DISTINCT FROM catalog.category)
 THEN RAISE EXCEPTION 'inventory reorder original minimum definition required';END IF;
 threshold:=(selected_minimum->>'quantity')::numeric;target_quantity:=COALESCE(selected_minimum#>>'{reorder,target}',selected_minimum->>'quantity')::numeric;
 current_quantity:=CASE WHEN signal->>'basis'='PHYSICAL' THEN physical ELSE physical-held-damaged END;
 IF signal->>'basis' IS DISTINCT FROM COALESCE(selected_minimum#>>'{reorder,basis}','PHYSICAL')
  OR threshold IS NULL OR target_quantity IS NULL OR threshold<0 OR target_quantity<threshold OR current_quantity>=threshold
  OR COALESCE(signal->>'minimum','')!~'^(0|[1-9][0-9]{0,62})$' OR(signal->>'minimum')::numeric<>threshold
  OR COALESCE(signal->>'target','')!~'^(0|[1-9][0-9]{0,62})$' OR(signal->>'target')::numeric<>target_quantity
  OR signal->>'current' IS DISTINCT FROM current_quantity::text
  OR COALESCE(signal->>'suggestedQuantity','')!~'^[1-9][0-9]{0,62}$' OR(signal->>'suggestedQuantity')::numeric<>target_quantity-current_quantity
  OR NEW.payload#>>'{inventory,item}' IS DISTINCT FROM catalog.key OR NEW.payload#>>'{inventory,quantity}' IS DISTINCT FROM current_quantity::text
  OR NEW.idempotency_key IS DISTINCT FROM 'inventory-below-minimum:'||place.id::text||':'||catalog.id::text||':'||current_revision::text||':'||policy.id::text
 THEN RAISE EXCEPTION 'inventory reorder exact configured quantity required';END IF;
 IF place.property_id IS NOT NULL THEN
  SELECT timezone INTO source_timezone FROM property WHERE organization_id=NEW.organization_id AND id=place.property_id;
 ELSE
  SELECT timezone INTO source_timezone FROM organization_profile WHERE organization_id=NEW.organization_id;
  IF source_timezone IS NULL THEN
   -- Use the original profile column's approved default; no business timezone
   -- is duplicated in the reorder engine or its database guard.
   SELECT pg_get_expr(d.adbin,d.adrelid) INTO timezone_default FROM pg_attrdef d JOIN pg_attribute a ON a.attrelid=d.adrelid AND a.attnum=d.adnum
    WHERE d.adrelid='organization_profile'::regclass AND a.attname='timezone';
   IF timezone_default IS NOT NULL THEN EXECUTE 'SELECT '||timezone_default INTO source_timezone;END IF;
  END IF;
 END IF;
 IF source_timezone IS NULL OR signal->>'timezone' IS DISTINCT FROM source_timezone THEN RAISE EXCEPTION 'inventory reorder original timezone required';END IF;
 IF signal#>>'{source,kind}'='MOVEMENT' THEN
  SELECT actor_id,created_at INTO original_actor,original_time FROM inventory_movement WHERE organization_id=NEW.organization_id
   AND movement_group_id=(signal#>>'{source,id}')::uuid AND location_id=place.id AND item_id=catalog.id AND revision=current_revision;
 ELSIF signal#>>'{source,kind}'='STOCKTAKE' THEN
  SELECT actor_id,received_at INTO original_actor,original_time FROM inventory_stocktake WHERE organization_id=NEW.organization_id
   AND id=(signal#>>'{source,id}')::uuid AND location_id=place.id AND item_id=catalog.id AND revision=current_revision;
 ELSE
  SELECT cause.created_by,cause.created_at INTO original_actor,original_time FROM config_rule cause WHERE cause.organization_id=NEW.organization_id
   AND cause.id=(signal#>>'{source,id}')::uuid AND cause.key='inventory.minimums' AND cause.lifecycle<>'DRAFT'
   AND(cause.scope_type='organization' AND cause.scope_id IS NULL OR cause.scope_type='property' AND cause.scope_id=place.property_id
    OR cause.scope_type='city' AND EXISTS(SELECT 1 FROM property p WHERE p.organization_id=NEW.organization_id AND p.id=place.property_id AND p.city_id=cause.scope_id)
    OR cause.scope_type='agreement' AND EXISTS(SELECT 1 FROM management_agreement a WHERE a.organization_id=NEW.organization_id AND a.id=cause.scope_id AND a.property_id=place.property_id));
 END IF;
 IF original_actor IS NULL OR signal->>'actorId' IS DISTINCT FROM original_actor::text
  OR original_time>NEW.occurred_at+interval '1 millisecond'
  OR(signal#>>'{source,kind}' IN('MOVEMENT','STOCKTAKE') AND original_time<>NEW.occurred_at)
 THEN RAISE EXCEPTION 'inventory reorder attributed original cause required';END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER inventory_reorder_signal_guard BEFORE INSERT OR UPDATE OR DELETE ON outbox_event
 FOR EACH ROW EXECUTE FUNCTION app_inventory_reorder_signal_guard();
