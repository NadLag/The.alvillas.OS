CREATE FUNCTION app_inventory_reorder_configuration_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE original config_rule; due_at timestamptz;
BEGIN
 IF TG_OP='DELETE' THEN
  IF OLD.type='inventory.reorder.configuration.requested' THEN RAISE EXCEPTION 'inventory reorder configuration reference is immutable';END IF;
  RETURN OLD;
 END IF;
 IF TG_OP='UPDATE' THEN
  IF(OLD.type='inventory.reorder.configuration.requested' OR NEW.type='inventory.reorder.configuration.requested')
   AND ROW(NEW.id,NEW.organization_id,NEW.type,NEW.payload,NEW.idempotency_key,NEW.occurred_at,NEW.created_at)
    IS DISTINCT FROM ROW(OLD.id,OLD.organization_id,OLD.type,OLD.payload,OLD.idempotency_key,OLD.occurred_at,OLD.created_at)
  THEN RAISE EXCEPTION 'inventory reorder configuration reference is immutable';END IF;
  RETURN NEW;
 END IF;
 IF NEW.type<>'inventory.reorder.configuration.requested' THEN RETURN NEW;END IF;
 SELECT * INTO original FROM config_rule WHERE organization_id=NEW.organization_id AND id=(NEW.payload->>'configRuleId')::uuid
  AND key='inventory.minimums' AND lifecycle<>'DRAFT' AND created_by IS NOT NULL;
 IF NOT FOUND OR NEW.payload->>'schemaVersion' IS DISTINCT FROM '1' OR COALESCE(NEW.payload->>'phase','') NOT IN('START','END')
  OR(NEW.payload-'schemaVersion'-'configRuleId'-'phase'-'after'-'automationPath')<>'{}'::jsonb
  OR abs(extract(epoch FROM(NEW.occurred_at-original.created_at)))>0.001
 THEN RAISE EXCEPTION 'inventory reorder configuration requires its original version';END IF;
 due_at:=CASE WHEN NEW.payload->>'phase'='START' THEN original.effective_from ELSE original.effective_to END;
 IF due_at IS NULL OR NEW.idempotency_key IS DISTINCT FROM 'inventory-reorder-config:'||original.id::text||':'||(NEW.payload->>'phase')||':'||
   (CASE WHEN NEW.payload ? 'after' THEN (NEW.payload#>>'{after,locationId}')||':'||(NEW.payload#>>'{after,itemId}') ELSE 'initial' END)
  OR NEW.status<>'PENDING' OR NEW.attempt_count<>0 OR NEW.processed_at IS NOT NULL
  OR NEW.next_attempt_at IS DISTINCT FROM (CASE WHEN NEW.payload ? 'after' THEN NULL ELSE due_at END)
 THEN RAISE EXCEPTION 'inventory reorder configuration native delivery required';END IF;
 IF NEW.payload ? 'after' AND(jsonb_typeof(NEW.payload->'after') IS DISTINCT FROM 'object'
  OR(NEW.payload->'after'-'locationId'-'itemId')<>'{}'::jsonb OR NOT EXISTS(SELECT 1 FROM inventory_location l JOIN inventory_item i ON i.organization_id=l.organization_id
   WHERE l.organization_id=NEW.organization_id AND l.id=(NEW.payload#>>'{after,locationId}')::uuid AND i.id=(NEW.payload#>>'{after,itemId}')::uuid))
 THEN RAISE EXCEPTION 'inventory reorder configuration original continuation required';END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER inventory_reorder_configuration_guard BEFORE INSERT OR UPDATE OR DELETE ON outbox_event
 FOR EACH ROW EXECUTE FUNCTION app_inventory_reorder_configuration_guard();
