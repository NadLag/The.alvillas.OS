CREATE FUNCTION app_supplier_price_receipt_immutable() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
 IF OLD.idempotency_key LIKE 'laundry-supplier-price:%' THEN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'supplier_price_original_receipt_immutable';END IF;
  IF NEW.id<>OLD.id OR NEW.organization_id<>OLD.organization_id OR NEW.idempotency_key<>OLD.idempotency_key OR NEW.type<>OLD.type OR NEW.payload IS DISTINCT FROM OLD.payload OR NEW.occurred_at<>OLD.occurred_at THEN RAISE EXCEPTION 'supplier_price_original_receipt_immutable';END IF;
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD;END IF;RETURN NEW;
END $$;
CREATE TRIGGER supplier_price_receipt_immutable BEFORE UPDATE OR DELETE ON outbox_event FOR EACH ROW EXECUTE FUNCTION app_supplier_price_receipt_immutable();

CREATE FUNCTION app_supplier_price_receipt_complete() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE p jsonb;draft jsonb;version supplier_price_list_version;source config_rule;original config_rule;source_xid xid;
BEGIN
 IF NEW.idempotency_key NOT LIKE 'laundry-supplier-price:%' AND NEW.type NOT IN('laundry.supplier_price.recorded','laundry.supplier_price.cancelled') THEN RETURN NULL;END IF;
 p:=NEW.payload;draft:=p->'draft';SELECT xmin INTO source_xid FROM outbox_event WHERE organization_id=NEW.organization_id AND id=NEW.id;
 IF p->>'schemaVersion' IS DISTINCT FROM '1' OR p->>'organizationId' IS DISTINCT FROM NEW.organization_id::text OR p->>'actorId' IS NULL OR p->>'idempotencyKey' IS NULL OR NEW.idempotency_key IS DISTINCT FROM 'laundry-supplier-price:'||(p->>'idempotencyKey') THEN RAISE EXCEPTION 'supplier_price_original_command_required';END IF;
 IF NEW.type='laundry.supplier_price.cancelled' THEN
  IF NOT EXISTS(SELECT 1 FROM audit_log a WHERE a.organization_id=NEW.organization_id AND a.actor_id::text=p->>'actorId' AND a.resource_type='laundry_supplier_price_command' AND a.resource_id::text=p->>'idempotencyKey' AND a.action=NEW.type AND a.after=p AND a.xmin=source_xid) THEN RAISE EXCEPTION 'supplier_price_original_negative_receipt_required';END IF;RETURN NULL;
 END IF;
 IF NEW.type<>'laundry.supplier_price.recorded' OR COALESCE(p->>'requestHash','')!~'^[a-f0-9]{64}$' OR COALESCE(p->>'reviewFingerprint','')!~'^[a-f0-9]{64}$' OR (p->>'createdAt')::timestamptz IS DISTINCT FROM NEW.occurred_at THEN RAISE EXCEPTION 'supplier_price_original_recorded_receipt_required';END IF;
 SELECT * INTO version FROM supplier_price_list_version WHERE organization_id=NEW.organization_id AND id::text=p->>'versionId';SELECT * INTO source FROM config_rule WHERE organization_id=NEW.organization_id AND id=version.config_rule_id;
 IF version.id IS NULL OR source.id IS NULL OR version.created_by::text IS DISTINCT FROM p->>'actorId' OR source.reason IS DISTINCT FROM draft->>'reason' OR source.effective_from IS DISTINCT FROM (draft->>'effectiveFrom')::timestamptz OR NOT EXISTS(SELECT 1 FROM supplier_price_list_version v WHERE v.organization_id=NEW.organization_id AND v.id=version.id AND v.xmin=source_xid) THEN RAISE EXCEPTION 'supplier_price_original_version_receipt_required';END IF;
 IF draft->>'kind'='CREATE' THEN
  IF draft->>'supplierId' IS DISTINCT FROM version.supplier_id::text OR source.scope_type IS DISTINCT FROM draft->'scope'->>'scopeType' OR source.scope_id::text IS DISTINCT FROM draft->'scope'->>'scopeId' OR source.value IS DISTINCT FROM draft->'policy' OR source.lifecycle IS DISTINCT FROM draft->>'lifecycle' OR source.effective_to IS DISTINCT FROM (draft->>'effectiveTo')::timestamptz THEN RAISE EXCEPTION 'supplier_price_original_definition_required';END IF;
 ELSIF draft->>'kind' IN('ACTIVATE','RETIRE') THEN
  SELECT c.* INTO original FROM supplier_price_list_version v JOIN config_rule c ON c.organization_id=v.organization_id AND c.id=v.config_rule_id WHERE v.organization_id=NEW.organization_id AND v.id::text=draft->>'versionId' AND v.supplier_id=version.supplier_id;
  IF original.id IS NULL OR original.key<>source.key OR original.scope_type<>source.scope_type OR original.scope_id IS DISTINCT FROM source.scope_id OR original.value IS DISTINCT FROM source.value OR source.lifecycle IS DISTINCT FROM(CASE draft->>'kind' WHEN 'ACTIVATE' THEN 'ACTIVE' ELSE 'RETIRED' END) THEN RAISE EXCEPTION 'supplier_price_original_lifecycle_required';END IF;
 ELSE RAISE EXCEPTION 'supplier_price_original_operation_required';END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER supplier_price_receipt_complete AFTER INSERT ON outbox_event DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app_supplier_price_receipt_complete();
