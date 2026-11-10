BEGIN;

-- Extend only the closed native shape. Every original step and its guards remain unchanged.
ALTER TABLE property_onboarding_revision DROP CONSTRAINT property_onboarding_revision_shape;
ALTER TABLE property_onboarding_revision ADD CONSTRAINT property_onboarding_revision_shape CHECK(coalesce(number>0
 AND ((step='OWNER' AND property_id IS NULL AND mode IN('CREATE','LINK'))
  OR (step='PROPERTY' AND property_id IS NOT NULL AND previous_id IS NOT NULL AND number>1 AND mode IN('CREATE','LINK'))
  OR (step='OPERATING_PROFILE' AND property_id IS NOT NULL AND previous_id IS NOT NULL AND number>2 AND mode IN('LINK','UPDATE'))
  OR (step='MANAGEMENT_AGREEMENT' AND property_id IS NOT NULL AND previous_id IS NOT NULL AND number>3 AND mode IN('CREATE','LINK'))
  OR (step='TEAM' AND property_id IS NOT NULL AND previous_id IS NOT NULL AND number>4 AND mode IN('LINK','ASSIGN'))
  OR (step='BOOKING_CHANNELS' AND property_id IS NOT NULL AND previous_id IS NOT NULL AND number>5 AND mode IN('LINK','CONFIGURE'))
  OR (step='INVENTORY' AND property_id IS NOT NULL AND previous_id IS NOT NULL AND number>6 AND mode IN('TEMPLATE','CUSTOM')))
 AND isfinite(created_at) AND payload_schema_version=1 AND octet_length(encrypted_payload) BETWEEN 64 AND (CASE WHEN step='OWNER' THEN 66304 WHEN step='INVENTORY' THEN 4194304 ELSE 196608 END)
 AND command_hash ~ '^[a-f0-9]{64}$' AND review_fingerprint ~ '^[a-f0-9]{64}$' AND source_fingerprint ~ '^[a-f0-9]{64}$'
 AND payload_sha256=encode(sha256(encrypted_payload),'hex') AND policy_version>0
 AND jsonb_typeof(source_snapshot)='object' AND jsonb_typeof(policy_snapshot)='object' AND jsonb_typeof(authorization_cap)='object'
 AND length(request_id) BETWEEN 1 AND 1000,false));


-- This additive guard retains all 227 earlier migration bytes and original guard functions.
CREATE FUNCTION app_guard_onboarding_inventory_revision() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE original property_onboarding_session%ROWTYPE;previous property_onboarding_revision%ROWTYPE;
 target owner%ROWTYPE;property_row property%ROWTYPE;rule config_rule%ROWTYPE;native_rule config_rule%ROWTYPE;
 native_binding property_template_revision%ROWTYPE;latest_binding property_template_revision%ROWTYPE;
 inventory_policy JSONB;minimum_items NUMERIC;owner_source JSONB;parent_source JSONB;property_source JSONB;ownership_source JSONB;
 owner_xmin TEXT;owner_tuple TEXT;property_xmin TEXT;property_tuple TEXT;manifest JSONB;part JSONB;pin JSONB;
 actual_pin JSONB;actual_templates JSONB;expected_templates JSONB;selected_rule UUID;selected_template UUID;prior_revision INTEGER;
BEGIN
 IF NEW.step IS DISTINCT FROM 'INVENTORY' THEN RETURN NEW; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(NEW.organization_id::text||':onboarding:session:'||NEW.session_id::text,0));
 SELECT * INTO original FROM property_onboarding_session WHERE organization_id=NEW.organization_id AND id=NEW.session_id;
 SELECT * INTO previous FROM property_onboarding_revision WHERE organization_id=NEW.organization_id AND session_id=NEW.session_id ORDER BY number DESC LIMIT 1;
 IF original.id IS NULL OR previous.id IS NULL OR previous.step NOT IN('BOOKING_CHANNELS','INVENTORY')
  OR NEW.previous_id IS DISTINCT FROM previous.id OR NEW.number<>previous.number+1
  OR NEW.owner_id IS DISTINCT FROM previous.owner_id OR NEW.property_id IS DISTINCT FROM previous.property_id
  OR NEW.created_at<original.created_at OR NEW.created_at<previous.created_at
 THEN RAISE EXCEPTION 'onboarding Inventory requires its actual consecutive saved Booking Channels predecessor'; END IF;
 IF NOT EXISTS(SELECT 1 FROM user_account WHERE organization_id=NEW.organization_id AND id=NEW.created_by AND status='ACTIVE' AND person_id IS NOT NULL)
 THEN RAISE EXCEPTION 'onboarding Inventory requires its actual active Account and Person'; END IF;
 SELECT * INTO rule FROM config_rule WHERE organization_id=NEW.organization_id AND id=NEW.policy_id FOR UPDATE;
 IF rule.id IS NULL OR rule.created_by IS NULL OR rule.key<>'onboarding.wizard' OR rule.scope_type<>'organization' OR rule.scope_id IS NOT NULL
  OR rule.archived_at IS NOT NULL OR rule.lifecycle NOT IN('ACTIVE','RETIRED') OR NEW.created_at<rule.effective_from OR (rule.effective_to IS NOT NULL AND NEW.created_at>=rule.effective_to)
  OR NEW.policy_version<>rule.version OR NEW.policy_snapshot IS DISTINCT FROM jsonb_build_object('id',rule.id,'version',rule.version,'value',rule.value)
  OR rule.value->>'source' IS DISTINCT FROM 'NATIVE_REVIEWED_PROPERTY_ONBOARDING'
  OR rule.value->>'history' IS DISTINCT FROM 'APPEND_ONLY_NATIVE_ONBOARDING_STEPS' OR rule.value->>'progress' IS DISTINCT FROM 'DERIVED_FROM_NATIVE_RECORDS'
  OR rule.value->>'encryption' IS DISTINCT FROM 'APP_MANAGED_AUTHENTICATED_ENCRYPTION' OR rule.value->>'release' IS DISTINCT FROM 'NATIVE_DELIVERY_READINESS'
 THEN RAISE EXCEPTION 'onboarding Inventory requires its actual approved organization policy'; END IF;

 IF NOT EXISTS(SELECT 1 FROM user_account a JOIN person p ON p.organization_id=a.organization_id AND p.id=a.person_id
  WHERE a.organization_id=NEW.organization_id AND a.id=NEW.created_by AND a.status='ACTIVE' AND p.archived_at IS NULL)
 THEN RAISE EXCEPTION 'onboarding Inventory requires its active canonical Person'; END IF;
 inventory_policy:=rule.value->'inventory';
 IF jsonb_typeof(inventory_policy) IS DISTINCT FROM 'object' OR inventory_policy-ARRAY['modes','minimum_items']<>'{}'::jsonb
  OR jsonb_typeof(inventory_policy->'modes') IS DISTINCT FROM 'array' OR jsonb_typeof(inventory_policy->'minimum_items') IS DISTINCT FROM 'number'
 THEN RAISE EXCEPTION 'onboarding Inventory requires explicit approved modes and minimum'; END IF;
 minimum_items:=(inventory_policy->>'minimum_items')::numeric;
 IF minimum_items<0 OR minimum_items>200 OR minimum_items<>trunc(minimum_items)
  OR jsonb_array_length(inventory_policy->'modes') NOT BETWEEN 1 AND 2
  OR (SELECT count(DISTINCT value) FROM jsonb_array_elements(inventory_policy->'modes'))<>jsonb_array_length(inventory_policy->'modes')
  OR EXISTS(SELECT 1 FROM jsonb_array_elements_text(inventory_policy->'modes') item WHERE item NOT IN('TEMPLATE','CUSTOM'))
  OR NOT coalesce(inventory_policy->'modes' ? NEW.mode,false)
 THEN RAISE EXCEPTION 'onboarding Inventory requires its enabled mode and configured minimum'; END IF;
 IF NEW.source_snapshot->>'source' IS DISTINCT FROM 'CORE_PROPERTY_INVENTORY'
  OR NEW.source_snapshot-ARRAY['source','parent','inventory','inputFingerprint']<>'{}'::jsonb
  OR NOT coalesce(NEW.source_snapshot->>'inputFingerprint' ~ '^[a-f0-9]{64}$',false)
 THEN RAISE EXCEPTION 'onboarding Inventory requires an identity-only source manifest and exact private input fingerprint'; END IF;
 parent_source:=NEW.source_snapshot->'parent';owner_source:=parent_source->'owner';property_source:=parent_source->'property';
 SELECT * INTO target FROM owner WHERE organization_id=NEW.organization_id AND id=NEW.owner_id AND archived_at IS NULL FOR UPDATE;
 SELECT xmin::text,ctid::text INTO owner_xmin,owner_tuple FROM owner WHERE organization_id=NEW.organization_id AND id=NEW.owner_id;
 IF target.id IS NULL OR owner_source->>'source' IS DISTINCT FROM 'CORE_OWNER_IDENTITY'
  OR owner_source->>'ownerId' IS DISTINCT FROM target.id::text OR owner_source->>'ownerXmin' IS DISTINCT FROM owner_xmin OR owner_source->>'ownerTuple' IS DISTINCT FROM owner_tuple
  OR (owner_source->>'ownerCreatedAt')::timestamptz IS DISTINCT FROM date_trunc('milliseconds',target.created_at)
  OR (owner_source->>'ownerUpdatedAt')::timestamptz IS DISTINCT FROM date_trunc('milliseconds',target.updated_at)
  OR owner_source-ARRAY['source','ownerId','ownerXmin','ownerTuple','ownerCreatedAt','ownerUpdatedAt']<>'{}'::jsonb
 THEN RAISE EXCEPTION 'onboarding Inventory requires its actual active canonical Owner source'; END IF;
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
 THEN RAISE EXCEPTION 'onboarding Inventory requires its actual physical, ownership and operating predecessor sources'; END IF;



 manifest:=NEW.source_snapshot->'inventory';
 IF jsonb_typeof(manifest) IS DISTINCT FROM 'object' OR manifest-ARRAY['before','after','templates']<>'{}'::jsonb
  OR jsonb_typeof(manifest->'templates') IS DISTINCT FROM 'array' OR jsonb_array_length(manifest->'templates')>2
  OR jsonb_typeof(manifest#>'{after,rule}') IS DISTINCT FROM 'object'
 THEN RAISE EXCEPTION 'onboarding Inventory requires bounded original rule and template witnesses'; END IF;
 FOR part IN SELECT value FROM jsonb_array_elements(jsonb_build_array(manifest->'before',manifest->'after')) LOOP
  IF jsonb_typeof(part) IS DISTINCT FROM 'object' OR part-ARRAY['rule','binding']<>'{}'::jsonb
   OR NOT(part ? 'rule') OR NOT(part ? 'binding')
  THEN RAISE EXCEPTION 'onboarding Inventory requires closed before and after witnesses'; END IF;
  pin:=part->'rule';
  IF pin IS DISTINCT FROM 'null'::jsonb THEN
   SELECT * INTO native_rule FROM config_rule WHERE organization_id=NEW.organization_id AND id=(pin->>'id')::uuid FOR UPDATE;
   SELECT jsonb_build_object('id',id,'rowVersion',xmin::text,'tuple',ctid::text) INTO actual_pin FROM config_rule WHERE organization_id=NEW.organization_id AND id=native_rule.id;
   IF native_rule.id IS NULL OR native_rule.key<>'inventory.minimums' OR actual_pin IS DISTINCT FROM pin
    OR native_rule.created_by IS NULL OR native_rule.archived_at IS NOT NULL OR native_rule.lifecycle<>'ACTIVE'
    OR NOT((native_rule.scope_type='organization' AND native_rule.scope_id IS NULL)
     OR (native_rule.scope_type='city' AND native_rule.scope_id=property_row.city_id)
     OR (native_rule.scope_type='owner' AND native_rule.scope_id=NEW.owner_id)
     OR (native_rule.scope_type='property' AND native_rule.scope_id=NEW.property_id)
     OR (native_rule.scope_type='agreement' AND native_rule.scope_id=(SELECT id FROM management_agreement WHERE organization_id=NEW.organization_id AND property_id=NEW.property_id AND archived_at IS NULL AND status<>'DRAFT' AND effective_from<=NEW.created_at AND(effective_to IS NULL OR effective_to>NEW.created_at) ORDER BY effective_from DESC,id DESC LIMIT 1)))
   THEN RAISE EXCEPTION 'onboarding Inventory requires actual same-tenant original effective-scope rule witnesses'; END IF;
  END IF;
  pin:=part->'binding';
  IF pin IS DISTINCT FROM 'null'::jsonb THEN
   SELECT * INTO native_binding FROM property_template_revision WHERE organization_id=NEW.organization_id AND property_id=NEW.property_id AND kind='INVENTORY' AND id=(pin->>'id')::uuid FOR UPDATE;
   SELECT jsonb_build_object('id',id,'rowVersion',xmin::text,'tuple',ctid::text,'revision',revision,'templateVersionId',template_version_id) INTO actual_pin FROM property_template_revision WHERE organization_id=NEW.organization_id AND id=native_binding.id;
   IF native_binding.id IS NULL OR actual_pin IS DISTINCT FROM pin THEN RAISE EXCEPTION 'onboarding Inventory requires actual immutable Property template revisions'; END IF;
  END IF;
 END LOOP;
 SELECT coalesce(jsonb_agg(value ORDER BY value->>'id'),'[]'::jsonb) INTO expected_templates FROM(SELECT DISTINCT jsonb_build_object('id',value->>'templateVersionId') AS value FROM jsonb_array_elements(jsonb_build_array(manifest#>'{before,binding}',manifest#>'{after,binding}')) value WHERE value IS DISTINCT FROM 'null'::jsonb) identities;
 IF(SELECT coalesce(jsonb_agg(jsonb_build_object('id',value->>'id') ORDER BY value->>'id'),'[]'::jsonb) FROM jsonb_array_elements(manifest->'templates')) IS DISTINCT FROM expected_templates
 THEN RAISE EXCEPTION 'onboarding Inventory must retain exactly its original bound and selected template identities'; END IF;
 PERFORM id FROM property_template_version WHERE organization_id=NEW.organization_id AND id IN(SELECT(value->>'id')::uuid FROM jsonb_array_elements(manifest->'templates')) ORDER BY id FOR UPDATE;
 SELECT coalesce(jsonb_agg(jsonb_build_object('id',id,'rowVersion',xmin::text,'tuple',ctid::text) ORDER BY id),'[]'::jsonb) INTO actual_templates FROM property_template_version
  WHERE organization_id=NEW.organization_id AND kind='INVENTORY' AND status='ACTIVE' AND(property_id IS NULL OR property_id=NEW.property_id)
   AND id IN(SELECT(value->>'id')::uuid FROM jsonb_array_elements(manifest->'templates'));
 IF actual_templates IS DISTINCT FROM manifest->'templates' THEN RAISE EXCEPTION 'onboarding Inventory requires actual canonical template identity witnesses'; END IF;
 SELECT * INTO latest_binding FROM property_template_revision WHERE organization_id=NEW.organization_id AND property_id=NEW.property_id AND kind='INVENTORY' ORDER BY revision DESC LIMIT 1;
 IF latest_binding.id IS DISTINCT FROM(manifest#>>'{after,binding,id}')::uuid THEN RAISE EXCEPTION 'onboarding Inventory requires its current canonical template binding'; END IF;
 -- Verify the recorded result against canonical effective-scope precedence, including scope retirement.
 WITH applicable AS(SELECT c.*,CASE c.scope_type WHEN 'agreement' THEN 5 WHEN 'property' THEN 4 WHEN 'owner' THEN 3 WHEN 'city' THEN 2 ELSE 1 END AS rank
  FROM config_rule c WHERE c.organization_id=NEW.organization_id AND c.key='inventory.minimums' AND c.archived_at IS NULL AND c.lifecycle IN('ACTIVE','RETIRED')
   AND c.effective_from<=NEW.created_at AND(c.effective_to IS NULL OR c.effective_to>NEW.created_at)
   AND((c.scope_type='organization' AND c.scope_id IS NULL) OR(c.scope_type='city' AND c.scope_id=property_row.city_id)
    OR(c.scope_type='owner' AND c.scope_id=NEW.owner_id) OR(c.scope_type='property' AND c.scope_id=NEW.property_id)
    OR(c.scope_type='agreement' AND c.scope_id=(SELECT id FROM management_agreement WHERE organization_id=NEW.organization_id AND property_id=NEW.property_id AND archived_at IS NULL AND status<>'DRAFT' AND effective_from<=NEW.created_at AND(effective_to IS NULL OR effective_to>NEW.created_at) ORDER BY effective_from DESC,id DESC LIMIT 1)))),
 latest_per_scope AS(SELECT DISTINCT ON(scope_type,scope_id) * FROM applicable ORDER BY scope_type,scope_id,effective_from DESC,version DESC)
 SELECT id INTO selected_rule FROM latest_per_scope WHERE lifecycle='ACTIVE' ORDER BY rank DESC,effective_from DESC,version DESC LIMIT 1;
 IF selected_rule IS NULL OR selected_rule IS DISTINCT FROM(manifest#>>'{after,rule,id}')::uuid THEN RAISE EXCEPTION 'onboarding Inventory must record its actual effective canonical result'; END IF;
 SELECT * INTO native_rule FROM config_rule WHERE organization_id=NEW.organization_id AND id=selected_rule;
 IF jsonb_typeof(native_rule.value->'minimums') IS DISTINCT FROM 'array' OR jsonb_array_length(native_rule.value->'minimums')<minimum_items OR jsonb_array_length(native_rule.value->'minimums')>200
 THEN RAISE EXCEPTION 'onboarding Inventory must meet its approved minimum and canonical item bound'; END IF;
 IF NEW.mode='CUSTOM' THEN
  IF manifest#>'{before,binding}' IS DISTINCT FROM manifest#>'{after,binding}' OR native_rule.scope_type<>'property' OR native_rule.scope_id IS DISTINCT FROM NEW.property_id OR native_rule.created_by IS DISTINCT FROM NEW.created_by
   OR NOT EXISTS(SELECT 1 FROM config_rule c JOIN audit_log event ON event.organization_id=c.organization_id AND event.resource_id=c.id
    WHERE c.organization_id=NEW.organization_id AND c.id=selected_rule AND c.xmin::text=pg_current_xact_id()::xid::text
     AND event.actor_id=NEW.created_by AND event.action='config_rule.version.created' AND event.resource_type='config_rule' AND event.property_scope_id=NEW.property_id
     AND event.request_id=NEW.request_id AND event.xmin::text=pg_current_xact_id()::xid::text)
  THEN RAISE EXCEPTION 'custom onboarding Inventory requires its atomic canonical configuration and attributed audit'; END IF;
 ELSE
  prior_revision:=coalesce((manifest#>>'{before,binding,revision}')::int,0);selected_template:=latest_binding.template_version_id;
  IF latest_binding.revision<>prior_revision+1 OR latest_binding.action<>'APPLY' OR latest_binding.created_by IS DISTINCT FROM NEW.created_by OR latest_binding.operation_id IS DISTINCT FROM NEW.command_key
   OR latest_binding.command->>'action' IS DISTINCT FROM 'APPLY' OR latest_binding.command->>'propertyId' IS DISTINCT FROM NEW.property_id::text
   OR latest_binding.command->>'templateVersionId' IS DISTINCT FROM selected_template::text OR(latest_binding.command->>'expectedRevision')::int IS DISTINCT FROM prior_revision
   OR NOT EXISTS(SELECT 1 FROM property_template_version t WHERE t.organization_id=NEW.organization_id AND t.id=selected_template AND t.status='ACTIVE'
    AND(SELECT status FROM property_template_version v WHERE v.organization_id=t.organization_id AND v.key=t.key ORDER BY version DESC LIMIT 1)='ACTIVE')
   OR NOT EXISTS(SELECT 1 FROM property_template_revision r JOIN audit_log event ON event.organization_id=r.organization_id AND event.resource_id=r.id
    WHERE r.organization_id=NEW.organization_id AND r.id=latest_binding.id AND r.xmin::text=pg_current_xact_id()::xid::text
     AND event.actor_id=NEW.created_by AND event.action='property_template.apply' AND event.resource_type='property_template_revision' AND event.property_scope_id=NEW.property_id
     AND event.request_id=NEW.request_id AND event.xmin::text=pg_current_xact_id()::xid::text)
  THEN RAISE EXCEPTION 'template onboarding Inventory requires its atomic canonical APPLY, nonce, revision and attributed audit'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER property_onboarding_inventory_native_guard BEFORE INSERT ON property_onboarding_revision
 FOR EACH ROW EXECUTE FUNCTION app_guard_onboarding_inventory_revision();
COMMIT;
