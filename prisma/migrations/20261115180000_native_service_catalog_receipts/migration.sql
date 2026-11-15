-- The existing config_rule is the only catalog. Its outbox receipt binds an
-- atomic, audited publication and remains immutable while dispatch may advance.
CREATE FUNCTION app_guard_service_catalog_outbox() RETURNS trigger
LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE payload jsonb;
BEGIN
 IF TG_OP='DELETE' THEN
  IF OLD.type='services.catalog.published' THEN RAISE EXCEPTION 'service_catalog_receipt_immutable'; END IF;
  RETURN OLD;
 END IF;
 IF TG_OP='UPDATE' THEN
  IF OLD.type='services.catalog.published' OR NEW.type='services.catalog.published' THEN
   IF ROW(OLD.id,OLD.organization_id,OLD.type,OLD.payload,OLD.idempotency_key,OLD.occurred_at,OLD.created_at)
    IS DISTINCT FROM ROW(NEW.id,NEW.organization_id,NEW.type,NEW.payload,NEW.idempotency_key,NEW.occurred_at,NEW.created_at)
   THEN RAISE EXCEPTION 'service_catalog_receipt_immutable'; END IF;
  END IF;
  RETURN NEW;
 END IF;
 IF NEW.type<>'services.catalog.published' THEN RETURN NEW; END IF;
 payload=NEW.payload;
 IF NOT coalesce(jsonb_typeof(payload)='object' AND payload->>'schemaVersion'='1'
  AND payload->>'actorId' ~ '^[a-f0-9-]{36}$' AND payload->>'propertyId' ~ '^[a-f0-9-]{36}$'
  AND (payload->'ownerId'='null'::jsonb OR payload->>'ownerId' ~ '^[a-f0-9-]{36}$')
  AND payload->>'ruleId' ~ '^[a-f0-9-]{36}$' AND payload->>'serviceKey' ~ '^[a-z][a-z0-9_.-]{0,99}$'
  AND payload->>'ruleVersion' ~ '^[1-9][0-9]*$'
  AND payload->>'commandHash' ~ '^[a-f0-9]{64}$' AND payload->>'reviewFingerprint' ~ '^[a-f0-9]{64}$'
  AND NEW.idempotency_key ~ '^service-catalog:[a-f0-9-]{36}$'
  AND NEW.status='PENDING' AND NEW.attempt_count=0 AND NEW.processed_at IS NULL AND NEW.next_attempt_at IS NULL AND NEW.last_error IS NULL,false)
 THEN RAISE EXCEPTION 'service_catalog_original_publication_required'; END IF;
 IF payload<>jsonb_build_object('schemaVersion',1,'actorId',payload->>'actorId','propertyId',payload->>'propertyId',
  'ownerId',payload->'ownerId','serviceKey',payload->>'serviceKey','ruleId',payload->>'ruleId',
  'ruleVersion',(payload->>'ruleVersion')::integer,'commandHash',payload->>'commandHash','reviewFingerprint',payload->>'reviewFingerprint')
 OR NOT EXISTS(
  SELECT 1 FROM config_rule r JOIN property p ON p.organization_id=r.organization_id AND p.id=r.scope_id
  JOIN user_account u ON u.organization_id=r.organization_id AND u.id=r.created_by
  WHERE r.organization_id=NEW.organization_id AND r.id=(payload->>'ruleId')::uuid
   AND r.key='services.pricing' AND r.scope_type='property' AND r.scope_id=(payload->>'propertyId')::uuid
   AND r.version=(payload->>'ruleVersion')::integer AND r.lifecycle='ACTIVE' AND r.archived_at IS NULL
   AND r.created_by=(payload->>'actorId')::uuid AND u.status='ACTIVE' AND p.archived_at IS NULL
   AND r.xmin::text=pg_current_xact_id()::xid::text
   AND NEW.occurred_at>=r.created_at AND NEW.occurred_at<=clock_timestamp()
   AND EXISTS(SELECT 1 FROM jsonb_array_elements(r.value->'services') item WHERE item->>'key'=payload->>'serviceKey')
   AND EXISTS(SELECT 1 FROM audit_log a WHERE a.organization_id=NEW.organization_id AND a.actor_id=u.id
    AND a.action='service.catalog.published' AND a.resource_type='config_rule' AND a.resource_id=r.id
    AND a.property_scope_id=r.scope_id AND a.after=payload||jsonb_build_object('key','services.pricing') AND a.reason=r.reason
    AND a.occurred_at=NEW.occurred_at AND a.xmin::text=pg_current_xact_id()::xid::text)
 ) THEN RAISE EXCEPTION 'service_catalog_atomic_audited_version_required'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER service_catalog_outbox_guard BEFORE INSERT OR UPDATE OR DELETE ON outbox_event
FOR EACH ROW EXECUTE FUNCTION app_guard_service_catalog_outbox();
