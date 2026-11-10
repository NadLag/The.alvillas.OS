BEGIN;

-- Extend only the closed native shape. Every original step and its guards remain unchanged.
ALTER TABLE property_onboarding_revision DROP CONSTRAINT property_onboarding_revision_shape;
ALTER TABLE property_onboarding_revision ADD CONSTRAINT property_onboarding_revision_shape CHECK(coalesce(number>0
 AND ((step='OWNER' AND property_id IS NULL AND mode IN('CREATE','LINK'))
  OR (step='PROPERTY' AND property_id IS NOT NULL AND previous_id IS NOT NULL AND number>1 AND mode IN('CREATE','LINK'))
  OR (step='OPERATING_PROFILE' AND property_id IS NOT NULL AND previous_id IS NOT NULL AND number>2 AND mode IN('LINK','UPDATE'))
  OR (step='MANAGEMENT_AGREEMENT' AND property_id IS NOT NULL AND previous_id IS NOT NULL AND number>3 AND mode IN('CREATE','LINK'))
  OR (step='TEAM' AND property_id IS NOT NULL AND previous_id IS NOT NULL AND number>4 AND mode IN('LINK','ASSIGN'))
  OR (step='BOOKING_CHANNELS' AND property_id IS NOT NULL AND previous_id IS NOT NULL AND number>5 AND mode IN('LINK','CONFIGURE')))
 AND isfinite(created_at) AND payload_schema_version=1 AND octet_length(encrypted_payload) BETWEEN 64 AND (CASE WHEN step='OWNER' THEN 66304 ELSE 196608 END)
 AND command_hash ~ '^[a-f0-9]{64}$' AND review_fingerprint ~ '^[a-f0-9]{64}$' AND source_fingerprint ~ '^[a-f0-9]{64}$'
 AND payload_sha256=encode(sha256(encrypted_payload),'hex') AND policy_version>0
 AND jsonb_typeof(source_snapshot)='object' AND jsonb_typeof(policy_snapshot)='object' AND jsonb_typeof(authorization_cap)='object'
 AND length(request_id) BETWEEN 1 AND 1000,false));


-- Preserve both previously applied native guard functions byte-for-byte.
CREATE FUNCTION app_guard_onboarding_booking_channels_revision() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE original property_onboarding_session%ROWTYPE;previous property_onboarding_revision%ROWTYPE;
 target owner%ROWTYPE;property_row property%ROWTYPE;rule config_rule%ROWTYPE;channel_policy JSONB;minimum_channels NUMERIC;
 owner_source JSONB;parent_source JSONB;property_source JSONB;ownership_source JSONB;
 owner_xmin TEXT;owner_tuple TEXT;property_xmin TEXT;property_tuple TEXT;
 actual_channels JSONB;channel_count INTEGER;channels_written_here BOOLEAN;
BEGIN
 IF NEW.step IS DISTINCT FROM 'BOOKING_CHANNELS' THEN RETURN NEW; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(NEW.organization_id::text||':onboarding:session:'||NEW.session_id::text,0));
 SELECT * INTO original FROM property_onboarding_session WHERE organization_id=NEW.organization_id AND id=NEW.session_id;
 SELECT * INTO previous FROM property_onboarding_revision WHERE organization_id=NEW.organization_id AND session_id=NEW.session_id ORDER BY number DESC LIMIT 1;
 IF original.id IS NULL OR previous.id IS NULL OR previous.step NOT IN('TEAM','BOOKING_CHANNELS')
  OR NEW.previous_id IS DISTINCT FROM previous.id OR NEW.number<>previous.number+1
  OR NEW.owner_id IS DISTINCT FROM previous.owner_id OR NEW.property_id IS DISTINCT FROM previous.property_id
  OR NEW.created_at<original.created_at OR NEW.created_at<previous.created_at
 THEN RAISE EXCEPTION 'onboarding Booking Channels requires its actual consecutive saved Team predecessor'; END IF;
 IF NOT EXISTS(SELECT 1 FROM user_account WHERE organization_id=NEW.organization_id AND id=NEW.created_by AND status='ACTIVE' AND person_id IS NOT NULL)
 THEN RAISE EXCEPTION 'onboarding Booking Channels requires its actual active Account and Person'; END IF;
 SELECT * INTO rule FROM config_rule WHERE organization_id=NEW.organization_id AND id=NEW.policy_id FOR UPDATE;
 IF rule.id IS NULL OR rule.created_by IS NULL OR rule.key<>'onboarding.wizard' OR rule.scope_type<>'organization' OR rule.scope_id IS NOT NULL
  OR rule.archived_at IS NOT NULL OR rule.lifecycle NOT IN('ACTIVE','RETIRED') OR NEW.created_at<rule.effective_from OR (rule.effective_to IS NOT NULL AND NEW.created_at>=rule.effective_to)
  OR NEW.policy_version<>rule.version OR NEW.policy_snapshot IS DISTINCT FROM jsonb_build_object('id',rule.id,'version',rule.version,'value',rule.value)
  OR rule.value->>'source' IS DISTINCT FROM 'NATIVE_REVIEWED_PROPERTY_ONBOARDING'
  OR rule.value->>'history' IS DISTINCT FROM 'APPEND_ONLY_NATIVE_ONBOARDING_STEPS' OR rule.value->>'progress' IS DISTINCT FROM 'DERIVED_FROM_NATIVE_RECORDS'
  OR rule.value->>'encryption' IS DISTINCT FROM 'APP_MANAGED_AUTHENTICATED_ENCRYPTION' OR rule.value->>'release' IS DISTINCT FROM 'NATIVE_DELIVERY_READINESS'
 THEN RAISE EXCEPTION 'onboarding Booking Channels requires its actual approved organization policy'; END IF;
 channel_policy:=rule.value->'booking_channels';
 IF jsonb_typeof(channel_policy) IS DISTINCT FROM 'object' OR channel_policy-ARRAY['modes','minimum_channels']<>'{}'::jsonb
  OR jsonb_typeof(channel_policy->'modes') IS DISTINCT FROM 'array' OR jsonb_typeof(channel_policy->'minimum_channels') IS DISTINCT FROM 'number'
 THEN RAISE EXCEPTION 'onboarding Booking Channels requires explicit approved modes and minimum'; END IF;
 minimum_channels:=(channel_policy->>'minimum_channels')::numeric;
 IF minimum_channels<0 OR minimum_channels>20 OR minimum_channels<>trunc(minimum_channels)
  OR jsonb_array_length(channel_policy->'modes') NOT BETWEEN 1 AND 2
  OR (SELECT count(DISTINCT value) FROM jsonb_array_elements(channel_policy->'modes'))<>jsonb_array_length(channel_policy->'modes')
  OR EXISTS(SELECT 1 FROM jsonb_array_elements_text(channel_policy->'modes') item WHERE item NOT IN('LINK','CONFIGURE'))
  OR NOT coalesce(channel_policy->'modes' ? NEW.mode,false)
 THEN RAISE EXCEPTION 'onboarding Booking Channels requires its actual enabled mode and configured minimum'; END IF;


 IF NEW.source_snapshot->>'source' IS DISTINCT FROM 'CORE_PROPERTY_BOOKING_CHANNELS'
  OR jsonb_typeof(NEW.source_snapshot->'channels') IS DISTINCT FROM 'array'
 THEN RAISE EXCEPTION 'onboarding Booking Channels requires identity-only canonical source manifests'; END IF;
 IF jsonb_array_length(NEW.source_snapshot->'channels')>20 OR jsonb_array_length(NEW.source_snapshot->'channels')<minimum_channels
  OR (NEW.mode='CONFIGURE' AND jsonb_array_length(NEW.source_snapshot->'channels')=0)
 THEN RAISE EXCEPTION 'onboarding Booking Channels must satisfy its configured minimum and bounded batch'; END IF;
 IF NEW.mode='CONFIGURE' THEN
  IF NEW.source_snapshot-ARRAY['source','parent','channels','inputFingerprint']<>'{}'::jsonb
   OR NOT coalesce(NEW.source_snapshot->>'inputFingerprint' ~ '^[a-f0-9]{64}$',false)
  THEN RAISE EXCEPTION 'configured onboarding Booking Channels requires its exact private input fingerprint'; END IF;
 ELSIF NEW.source_snapshot-ARRAY['source','parent','channels']<>'{}'::jsonb THEN
  RAISE EXCEPTION 'linked onboarding Booking Channels cannot invent inputs or plaintext private values';
 END IF;
 parent_source:=NEW.source_snapshot->'parent';owner_source:=parent_source->'owner';property_source:=parent_source->'property';
 SELECT * INTO target FROM owner WHERE organization_id=NEW.organization_id AND id=NEW.owner_id AND archived_at IS NULL FOR UPDATE;
 SELECT xmin::text,ctid::text INTO owner_xmin,owner_tuple FROM owner WHERE organization_id=NEW.organization_id AND id=NEW.owner_id;
 IF target.id IS NULL OR owner_source->>'source' IS DISTINCT FROM 'CORE_OWNER_IDENTITY'
  OR owner_source->>'ownerId' IS DISTINCT FROM target.id::text OR owner_source->>'ownerXmin' IS DISTINCT FROM owner_xmin OR owner_source->>'ownerTuple' IS DISTINCT FROM owner_tuple
  OR (owner_source->>'ownerCreatedAt')::timestamptz IS DISTINCT FROM date_trunc('milliseconds',target.created_at)
  OR (owner_source->>'ownerUpdatedAt')::timestamptz IS DISTINCT FROM date_trunc('milliseconds',target.updated_at)
  OR owner_source-ARRAY['source','ownerId','ownerXmin','ownerTuple','ownerCreatedAt','ownerUpdatedAt']<>'{}'::jsonb
 THEN RAISE EXCEPTION 'onboarding Booking Channels requires its actual active canonical Owner source'; END IF;
 SELECT * INTO property_row FROM property WHERE organization_id=NEW.organization_id AND id=NEW.property_id AND archived_at IS NULL FOR UPDATE;
 PERFORM id FROM property_owner WHERE organization_id=NEW.organization_id AND property_id=NEW.property_id AND archived_at IS NULL ORDER BY id FOR UPDATE;
 PERFORM id FROM property_operating_profile WHERE organization_id=NEW.organization_id AND property_id=NEW.property_id FOR UPDATE;
 SELECT xmin::text,ctid::text INTO property_xmin,property_tuple FROM property WHERE organization_id=NEW.organization_id AND id=NEW.property_id;
 SELECT coalesce(jsonb_agg(jsonb_build_object('id',po.id,'ownerId',po.owner_id,'isPrimary',po.is_primary,'xmin',po.xmin::text,'tuple',po.ctid::text) ORDER BY po.owner_id),'[]'::jsonb)
  INTO ownership_source FROM property_owner po WHERE po.organization_id=NEW.organization_id AND po.property_id=NEW.property_id AND po.archived_at IS NULL;
 IF property_row.id IS NULL OR property_row.status NOT IN('DRAFT','ONBOARDING')
  OR NOT EXISTS(SELECT 1 FROM property_owner po WHERE po.organization_id=NEW.organization_id AND po.property_id=NEW.property_id AND po.owner_id=NEW.owner_id AND po.archived_at IS NULL)
  OR parent_source->>'source' IS DISTINCT FROM 'CORE_PROPERTY_IDENTITY' OR parent_source-ARRAY['source','owner','property','initialConfiguration']<>'{}'::jsonb
  OR parent_source->'initialConfiguration' IS DISTINCT FROM 'null'::jsonb
  OR (property_source->>'createdAt')::timestamptz IS DISTINCT FROM date_trunc('milliseconds',property_row.created_at)
  OR (property_source->>'updatedAt')::timestamptz IS DISTINCT FROM date_trunc('milliseconds',property_row.updated_at)
  OR property_source-ARRAY['createdAt','updatedAt'] IS DISTINCT FROM jsonb_build_object('id',property_row.id,'organizationId',property_row.organization_id,'status',property_row.status,
   'cityId',property_row.city_id,'regionId',property_row.region_id,'createdBy',property_row.created_by,'archivedAt',NULL,'xmin',property_xmin,'tuple',property_tuple,'ownership',ownership_source,
   'operatingProfile',(SELECT jsonb_build_object('id',op.id,'xmin',op.xmin::text,'tuple',op.ctid::text) FROM property_operating_profile op WHERE op.organization_id=NEW.organization_id AND op.property_id=NEW.property_id))
 THEN RAISE EXCEPTION 'onboarding Booking Channels requires its actual physical, ownership and operating predecessor sources'; END IF;


 PERFORM id FROM booking_channel WHERE organization_id=NEW.organization_id AND property_id=NEW.property_id
  AND id IN(SELECT (item->>'id')::uuid FROM jsonb_array_elements(NEW.source_snapshot->'channels') item) ORDER BY id FOR UPDATE;
 SELECT count(*)::int,coalesce(bool_and(c.xmin::text=pg_current_xact_id()::xid::text),false),
  coalesce(jsonb_agg(jsonb_build_object('id',c.id,'propertyId',c.property_id,'rowVersion',c.xmin::text,'tuple',c.ctid::text) ORDER BY c.id),'[]'::jsonb)
  INTO channel_count,channels_written_here,actual_channels FROM booking_channel c WHERE c.organization_id=NEW.organization_id
   AND c.property_id=NEW.property_id AND c.archived_at IS NULL
   AND c.status IN('ACTIVE','PAUSED','DISCONNECTED') AND c.sync_mode IN('MANUAL','ICAL','API','CSV','CHANNEL_MANAGER')
   AND c.id IN(SELECT (item->>'id')::uuid FROM jsonb_array_elements(NEW.source_snapshot->'channels') item);
 IF channel_count<>jsonb_array_length(NEW.source_snapshot->'channels') OR actual_channels IS DISTINCT FROM NEW.source_snapshot->'channels'
 THEN RAISE EXCEPTION 'onboarding Booking Channels requires exact current canonical Property channel identities and versions'; END IF;
 -- CONFIGURE may update real existing rows. Their original creator and creation time remain untouched.
 IF NEW.mode='CONFIGURE' AND (NOT channels_written_here OR EXISTS(
  SELECT 1 FROM booking_channel c WHERE c.organization_id=NEW.organization_id AND c.id IN(SELECT (item->>'id')::uuid FROM jsonb_array_elements(actual_channels) item)
   AND NOT EXISTS(SELECT 1 FROM audit_log event WHERE event.organization_id=NEW.organization_id AND event.actor_id=NEW.created_by
    AND event.action='property.booking_channel.upsert' AND event.resource_type='booking_channel' AND event.resource_id=c.id
    AND event.property_scope_id=NEW.property_id AND event.request_id=NEW.request_id AND event.xmin::text=pg_current_xact_id()::xid::text)))
 THEN RAISE EXCEPTION 'onboarding Booking Channels requires every atomic canonical configuration and original attributed audit'; END IF;
 RETURN NEW;
END $$;

CREATE TRIGGER property_onboarding_booking_channels_native_guard BEFORE INSERT ON property_onboarding_revision
 FOR EACH ROW EXECUTE FUNCTION app_guard_onboarding_booking_channels_revision();

COMMIT;
