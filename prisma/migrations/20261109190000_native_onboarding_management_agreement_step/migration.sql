BEGIN;

-- Add the next native step; retain original bounds, identity, append-only, audit/outbox and tenant guards.
ALTER TABLE property_onboarding_revision DROP CONSTRAINT property_onboarding_revision_shape;
ALTER TABLE property_onboarding_revision ADD CONSTRAINT property_onboarding_revision_shape CHECK(coalesce(number>0
 AND ((step='OWNER' AND property_id IS NULL AND mode IN('CREATE','LINK'))
  OR (step='PROPERTY' AND property_id IS NOT NULL AND previous_id IS NOT NULL AND number>1 AND mode IN('CREATE','LINK'))
  OR (step='OPERATING_PROFILE' AND property_id IS NOT NULL AND previous_id IS NOT NULL AND number>2 AND mode IN('LINK','UPDATE'))
  OR (step='MANAGEMENT_AGREEMENT' AND property_id IS NOT NULL AND previous_id IS NOT NULL AND number>3 AND mode IN('CREATE','LINK')))
 AND isfinite(created_at) AND payload_schema_version=1 AND octet_length(encrypted_payload) BETWEEN 64 AND (CASE WHEN step='OWNER' THEN 66304 ELSE 196608 END)
 AND command_hash ~ '^[a-f0-9]{64}$' AND review_fingerprint ~ '^[a-f0-9]{64}$' AND source_fingerprint ~ '^[a-f0-9]{64}$'
 AND payload_sha256=encode(sha256(encrypted_payload),'hex') AND policy_version>0
 AND jsonb_typeof(source_snapshot)='object' AND jsonb_typeof(policy_snapshot)='object' AND jsonb_typeof(authorization_cap)='object'
 AND length(request_id) BETWEEN 1 AND 1000,false));

CREATE OR REPLACE FUNCTION app_guard_onboarding_revision() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE original property_onboarding_session%ROWTYPE;previous property_onboarding_revision%ROWTYPE;target owner%ROWTYPE;owner_xmin TEXT;owner_tuple TEXT;rule config_rule%ROWTYPE;property_row property%ROWTYPE;property_xmin TEXT;property_tuple TEXT;owner_source JSONB;property_source JSONB;ownership_source JSONB;configuration_source JSONB;configuration_row config_rule%ROWTYPE;configuration_xmin TEXT;configuration_tuple TEXT;identity_source JSONB;operating_row property_operating_profile%ROWTYPE;operating_source JSONB;operating_scopes JSONB;agreement_id UUID;operating_rule config_rule%ROWTYPE;operating_rule_xmin TEXT;operating_rule_tuple TEXT;management_row management_agreement%ROWTYPE;management_xmin TEXT;management_tuple TEXT;management_rules JSONB;management_count INTEGER;management_rules_valid BOOLEAN;management_birth_valid BOOLEAN;
BEGIN
 -- Unsupported steps must reach the existing closed table shape constraint, retaining its original rejection contract.
 IF NEW.step IS NULL OR NEW.step NOT IN('OWNER','PROPERTY','OPERATING_PROFILE','MANAGEMENT_AGREEMENT') THEN RETURN NEW; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(NEW.organization_id::text||':onboarding:session:'||NEW.session_id::text,0));
 SELECT * INTO original FROM property_onboarding_session WHERE organization_id=NEW.organization_id AND id=NEW.session_id;
 SELECT * INTO previous FROM property_onboarding_revision WHERE organization_id=NEW.organization_id AND session_id=NEW.session_id ORDER BY number DESC LIMIT 1;
 IF original.id IS NULL OR NEW.previous_id IS DISTINCT FROM previous.id OR NEW.number<>coalesce(previous.number,0)+1
  OR NEW.created_at<original.created_at OR (previous.id IS NOT NULL AND NEW.created_at<previous.created_at)
  OR (previous.id IS NULL AND (original.created_by<>NEW.created_by OR original.created_at<>NEW.created_at OR original.request_id<>NEW.request_id))
 THEN RAISE EXCEPTION 'onboarding requires its actual consecutive native session head'; END IF;
 IF NEW.step='OWNER' AND previous.id IS NOT NULL AND previous.step<>'OWNER' THEN RAISE EXCEPTION 'onboarding Owner correction cannot discard an admitted Property step'; END IF;
 IF NEW.step='PROPERTY' AND (previous.id IS NULL OR previous.step NOT IN('OWNER','PROPERTY') OR NEW.owner_id IS DISTINCT FROM previous.owner_id) THEN RAISE EXCEPTION 'onboarding Property requires its saved canonical Owner predecessor'; END IF;
 IF NEW.step='OPERATING_PROFILE' AND (previous.id IS NULL OR previous.step NOT IN('PROPERTY','OPERATING_PROFILE') OR NEW.owner_id IS DISTINCT FROM previous.owner_id OR NEW.property_id IS DISTINCT FROM previous.property_id) THEN RAISE EXCEPTION 'onboarding Operating Profile requires its saved canonical Property predecessor'; END IF;
 IF NEW.step='MANAGEMENT_AGREEMENT' AND (previous.id IS NULL OR previous.step NOT IN('OPERATING_PROFILE','MANAGEMENT_AGREEMENT') OR NEW.owner_id IS DISTINCT FROM previous.owner_id OR NEW.property_id IS DISTINCT FROM previous.property_id) THEN RAISE EXCEPTION 'onboarding Management Agreement requires its saved canonical Operating Profile predecessor'; END IF;
 identity_source:=CASE WHEN NEW.step='OPERATING_PROFILE' THEN NEW.source_snapshot->'property' WHEN NEW.step='MANAGEMENT_AGREEMENT' THEN NEW.source_snapshot->'parent' ELSE NEW.source_snapshot END;
 owner_source:=CASE WHEN NEW.step='OWNER' THEN identity_source ELSE identity_source->'owner' END;
 SELECT * INTO target FROM owner WHERE organization_id=NEW.organization_id AND id=NEW.owner_id AND archived_at IS NULL FOR UPDATE;
 SELECT xmin::text,ctid::text INTO owner_xmin,owner_tuple FROM owner WHERE organization_id=NEW.organization_id AND id=NEW.owner_id;
 IF target.id IS NULL OR owner_source->>'source' IS DISTINCT FROM 'CORE_OWNER_IDENTITY'
  OR owner_source->>'ownerId' IS DISTINCT FROM target.id::text OR owner_source->>'ownerXmin' IS DISTINCT FROM owner_xmin
  OR owner_source->>'ownerTuple' IS DISTINCT FROM owner_tuple
  OR (owner_source->>'ownerCreatedAt')::timestamptz IS DISTINCT FROM date_trunc('milliseconds',target.created_at)
  OR (owner_source->>'ownerUpdatedAt')::timestamptz IS DISTINCT FROM date_trunc('milliseconds',target.updated_at)
  OR owner_source-ARRAY['source','ownerId','ownerXmin','ownerTuple','ownerCreatedAt','ownerUpdatedAt']<>'{}'::jsonb
 THEN RAISE EXCEPTION 'onboarding requires its actual active canonical owner source'; END IF;
 IF NEW.step='OWNER' AND NEW.mode='CREATE' AND (target.created_by IS DISTINCT FROM NEW.created_by OR owner_xmin IS DISTINCT FROM pg_current_xact_id()::xid::text
  OR NOT EXISTS(SELECT 1 FROM audit_log a WHERE a.organization_id=NEW.organization_id AND a.actor_id=NEW.created_by AND a.action='owner.create'
   AND a.resource_type='owner' AND a.resource_id=target.id AND a.request_id=NEW.request_id AND a.xmin::text=pg_current_xact_id()::xid::text))
 THEN RAISE EXCEPTION 'onboarding requires atomic canonical owner creation'; END IF;
 SELECT * INTO rule FROM config_rule WHERE organization_id=NEW.organization_id AND id=NEW.policy_id;
 IF rule.id IS NULL OR rule.created_by IS NULL OR rule.key<>'onboarding.wizard' OR rule.scope_type<>'organization' OR rule.scope_id IS NOT NULL
  OR rule.archived_at IS NOT NULL OR rule.lifecycle NOT IN('ACTIVE','RETIRED') OR NEW.created_at<rule.effective_from OR (rule.effective_to IS NOT NULL AND NEW.created_at>=rule.effective_to)
  OR NEW.policy_version<>rule.version OR NEW.policy_snapshot IS DISTINCT FROM jsonb_build_object('id',rule.id,'version',rule.version,'value',rule.value)
  OR rule.value->>'source' IS DISTINCT FROM 'NATIVE_REVIEWED_PROPERTY_ONBOARDING'
  OR rule.value->>'history' IS DISTINCT FROM 'APPEND_ONLY_NATIVE_ONBOARDING_STEPS' OR rule.value->>'progress' IS DISTINCT FROM 'DERIVED_FROM_NATIVE_RECORDS'
  OR rule.value->>'encryption' IS DISTINCT FROM 'APP_MANAGED_AUTHENTICATED_ENCRYPTION' OR rule.value->>'release' IS DISTINCT FROM 'NATIVE_DELIVERY_READINESS'
  OR NOT coalesce(rule.value->(CASE WHEN NEW.step='OWNER' THEN 'owner_modes' WHEN NEW.step='PROPERTY' THEN 'property_modes' WHEN NEW.step='MANAGEMENT_AGREEMENT' THEN 'management_agreement_modes' ELSE 'operating_profile_modes' END) ? NEW.mode,false)
 THEN RAISE EXCEPTION 'onboarding requires its actual approved organization policy'; END IF;

 IF NEW.step IN('PROPERTY','OPERATING_PROFILE','MANAGEMENT_AGREEMENT') THEN
  SELECT * INTO property_row FROM property WHERE organization_id=NEW.organization_id AND id=NEW.property_id AND archived_at IS NULL FOR UPDATE;
  PERFORM id FROM property_owner WHERE organization_id=NEW.organization_id AND property_id=NEW.property_id AND archived_at IS NULL ORDER BY id FOR UPDATE;
  PERFORM id FROM property_operating_profile WHERE organization_id=NEW.organization_id AND property_id=NEW.property_id FOR UPDATE;
  SELECT xmin::text,ctid::text INTO property_xmin,property_tuple FROM property WHERE organization_id=NEW.organization_id AND id=NEW.property_id;
  SELECT coalesce(jsonb_agg(jsonb_build_object('id',po.id,'ownerId',po.owner_id,'isPrimary',po.is_primary,'xmin',po.xmin::text,'tuple',po.ctid::text) ORDER BY po.owner_id),'[]'::jsonb)
   INTO ownership_source FROM property_owner po WHERE po.organization_id=NEW.organization_id AND po.property_id=NEW.property_id AND po.archived_at IS NULL;
  property_source:=identity_source->'property';
  IF property_row.id IS NULL OR property_row.status NOT IN('DRAFT','ONBOARDING')
   OR NOT EXISTS(SELECT 1 FROM property_owner po WHERE po.organization_id=NEW.organization_id AND po.property_id=property_row.id AND po.owner_id=NEW.owner_id AND po.archived_at IS NULL)
   OR identity_source->>'source' IS DISTINCT FROM 'CORE_PROPERTY_IDENTITY'
   OR identity_source-ARRAY['source','owner','property','initialConfiguration']<>'{}'::jsonb
   OR (property_source->>'createdAt')::timestamptz IS DISTINCT FROM date_trunc('milliseconds',property_row.created_at)
   OR (property_source->>'updatedAt')::timestamptz IS DISTINCT FROM date_trunc('milliseconds',property_row.updated_at)
   OR property_source-ARRAY['createdAt','updatedAt'] IS DISTINCT FROM jsonb_build_object('id',property_row.id,'organizationId',property_row.organization_id,'status',property_row.status,
    'cityId',property_row.city_id,'regionId',property_row.region_id,'createdBy',property_row.created_by,'archivedAt',NULL,'xmin',property_xmin,'tuple',property_tuple,'ownership',ownership_source,
    'operatingProfile',(SELECT jsonb_build_object('id',op.id,'xmin',op.xmin::text,'tuple',op.ctid::text) FROM property_operating_profile op WHERE op.organization_id=NEW.organization_id AND op.property_id=property_row.id))
  THEN RAISE EXCEPTION 'onboarding Property requires its actual active physical and ownership source'; END IF;
  configuration_source:=identity_source->'initialConfiguration';
  IF NEW.mode='LINK' OR NEW.step IN('OPERATING_PROFILE','MANAGEMENT_AGREEMENT') THEN
   IF configuration_source IS DISTINCT FROM 'null'::jsonb THEN RAISE EXCEPTION 'linked onboarding Property cannot invent initial configuration'; END IF;
  ELSE
   SELECT * INTO configuration_row FROM config_rule WHERE organization_id=NEW.organization_id AND id=(configuration_source->>'id')::uuid FOR UPDATE;
   SELECT xmin::text,ctid::text INTO configuration_xmin,configuration_tuple FROM config_rule WHERE organization_id=NEW.organization_id AND id=configuration_row.id;
   IF property_row.status<>'DRAFT' OR property_row.created_by IS DISTINCT FROM NEW.created_by OR property_xmin IS DISTINCT FROM pg_current_xact_id()::xid::text
    OR NOT EXISTS(SELECT 1 FROM audit_log a WHERE a.organization_id=NEW.organization_id AND a.actor_id=NEW.created_by AND a.action='property.create'
     AND a.resource_type='property' AND a.resource_id=property_row.id AND a.property_scope_id=property_row.id AND a.request_id=NEW.request_id AND a.xmin::text=pg_current_xact_id()::xid::text)
    OR NOT EXISTS(SELECT 1 FROM property_operating_profile p WHERE p.organization_id=NEW.organization_id AND p.property_id=property_row.id
     AND p.created_by=NEW.created_by AND p.xmin::text=pg_current_xact_id()::xid::text)
   THEN RAISE EXCEPTION 'onboarding Property requires atomic canonical creation and configured operating profile'; END IF;
   IF jsonb_typeof(configuration_source) IS DISTINCT FROM 'object' OR configuration_row.id IS NULL OR configuration_row.created_by IS NULL
    OR configuration_row.key<>'ops.operating_rules' OR configuration_row.scope_type<>'organization' OR configuration_row.scope_id IS NOT NULL
    OR configuration_row.archived_at IS NOT NULL OR configuration_row.lifecycle<>'ACTIVE'
    OR NEW.created_at<configuration_row.effective_from OR (configuration_row.effective_to IS NOT NULL AND NEW.created_at>=configuration_row.effective_to)
    OR rule.value->'property_creation_rule'->>'key' IS DISTINCT FROM configuration_row.key
    OR configuration_source->>'entry' IS DISTINCT FROM rule.value->'property_creation_rule'->>'entry'
    OR NOT coalesce(configuration_row.value->'rules' ? (configuration_source->>'entry'),false)
    OR configuration_source IS DISTINCT FROM jsonb_build_object('id',configuration_row.id,'version',configuration_row.version,'key',configuration_row.key,
     'entry',rule.value->'property_creation_rule'->>'entry','xmin',configuration_xmin,'tuple',configuration_tuple)
   THEN RAISE EXCEPTION 'onboarding Property requires its actual approved initial configuration tuple'; END IF;
  END IF;
 END IF;
 IF NEW.step='OPERATING_PROFILE' THEN
  SELECT * INTO operating_row FROM property_operating_profile WHERE organization_id=NEW.organization_id AND property_id=NEW.property_id;
  IF operating_row.id IS NULL OR NEW.source_snapshot->>'source' IS DISTINCT FROM 'CORE_PROPERTY_OPERATING_PROFILE'
   OR NEW.source_snapshot-ARRAY['source','property','profileFingerprint','operatingRule']<>'{}'::jsonb
   OR NOT coalesce(NEW.source_snapshot->>'profileFingerprint' ~ '^[a-f0-9]{64}$',false)
  THEN RAISE EXCEPTION 'onboarding Operating Profile requires its actual canonical profile source'; END IF;
  IF NEW.mode='UPDATE' AND (
   NOT EXISTS(SELECT 1 FROM property_operating_profile op WHERE op.organization_id=NEW.organization_id AND op.property_id=NEW.property_id AND op.xmin::text=pg_current_xact_id()::xid::text)
   OR NOT EXISTS(SELECT 1 FROM audit_log a WHERE a.organization_id=NEW.organization_id AND a.actor_id=NEW.created_by AND a.action='property.operating_profile.update'
    AND a.resource_type='property' AND a.resource_id=NEW.property_id AND a.property_scope_id=NEW.property_id AND a.request_id=NEW.request_id AND a.xmin::text=pg_current_xact_id()::xid::text))
  THEN RAISE EXCEPTION 'onboarding Operating Profile requires its atomic canonical Core update and audit'; END IF;
  operating_source:=NEW.source_snapshot->'operatingRule';
  IF NOT operating_row.mid_stay_cleaning_enabled THEN
   IF operating_source IS DISTINCT FROM 'null'::jsonb THEN RAISE EXCEPTION 'disabled mid-stay cleaning cannot invent a rule'; END IF;
  ELSE
   SELECT id INTO agreement_id FROM management_agreement WHERE organization_id=NEW.organization_id AND property_id=NEW.property_id AND archived_at IS NULL AND status<>'DRAFT'
    AND effective_from<=NEW.created_at AND (effective_to IS NULL OR effective_to>NEW.created_at) ORDER BY effective_from DESC,id DESC LIMIT 1;
   operating_scopes:=jsonb_build_array(jsonb_build_object('scopeType','organization','scopeId',NULL))
    || CASE WHEN property_row.city_id IS NULL THEN '[]'::jsonb ELSE jsonb_build_array(jsonb_build_object('scopeType','city','scopeId',property_row.city_id)) END
    || jsonb_build_array(jsonb_build_object('scopeType','owner','scopeId',NEW.owner_id),jsonb_build_object('scopeType','property','scopeId',NEW.property_id))
    || CASE WHEN agreement_id IS NULL THEN '[]'::jsonb ELSE jsonb_build_array(jsonb_build_object('scopeType','agreement','scopeId',agreement_id)) END;
   -- Resolve current scope heads with the same retirement and specificity rules as ConfigRuleRepository.
   SELECT c.* INTO operating_rule FROM config_rule c JOIN (
    SELECT id FROM (
     SELECT r.id,r.lifecycle,r.scope_type,r.effective_from,r.version,row_number() OVER(PARTITION BY r.scope_type,r.scope_id ORDER BY r.effective_from DESC,r.version DESC) AS scope_position
     FROM config_rule r JOIN jsonb_to_recordset(operating_scopes) AS s("scopeType" TEXT,"scopeId" TEXT)
      ON r.scope_type=s."scopeType" AND r.scope_id IS NOT DISTINCT FROM s."scopeId"::uuid
     WHERE r.organization_id=NEW.organization_id AND r.key='ops.mid_stay_threshold' AND r.archived_at IS NULL AND r.lifecycle IN('ACTIVE','RETIRED')
      AND r.effective_from<=NEW.created_at AND (r.effective_to IS NULL OR r.effective_to>NEW.created_at)
    ) heads WHERE scope_position=1 AND lifecycle='ACTIVE'
    ORDER BY CASE scope_type WHEN 'agreement' THEN 5 WHEN 'property' THEN 4 WHEN 'owner' THEN 3 WHEN 'city' THEN 2 WHEN 'organization' THEN 1 ELSE 0 END DESC,effective_from DESC,version DESC LIMIT 1
   ) resolved ON resolved.id=c.id WHERE c.organization_id=NEW.organization_id FOR UPDATE OF c;
   SELECT xmin::text,ctid::text INTO operating_rule_xmin,operating_rule_tuple FROM config_rule WHERE organization_id=NEW.organization_id AND id=operating_rule.id;
   IF operating_row.mid_stay_cleaning_rule_key IS DISTINCT FROM 'ops.mid_stay_threshold' OR operating_rule.id IS NULL OR operating_rule.created_by IS NULL
    OR operating_source IS DISTINCT FROM jsonb_build_object('scopes',operating_scopes,'pin',jsonb_build_object('id',operating_rule.id,'key',operating_rule.key,'version',operating_rule.version,
      'scopeType',operating_rule.scope_type,'scopeId',operating_rule.scope_id,'xmin',operating_rule_xmin,'tuple',operating_rule_tuple))
   THEN RAISE EXCEPTION 'onboarding Operating Profile requires its actual resolved mid-stay rule and version'; END IF;
  END IF;
 END IF;
 IF NEW.step='MANAGEMENT_AGREEMENT' THEN
  SELECT * INTO management_row FROM management_agreement WHERE organization_id=NEW.organization_id AND id=(NEW.source_snapshot->'agreement'->>'id')::uuid AND property_id=NEW.property_id AND archived_at IS NULL FOR UPDATE;
  SELECT xmin::text,ctid::text INTO management_xmin,management_tuple FROM management_agreement WHERE organization_id=NEW.organization_id AND id=management_row.id;
  IF management_row.id IS NULL OR management_row.created_by IS NULL OR management_row.status NOT IN('DRAFT','ACTIVE')
   OR NEW.source_snapshot->>'source' IS DISTINCT FROM 'CORE_MANAGEMENT_AGREEMENT'
   OR NEW.source_snapshot->'agreement' IS DISTINCT FROM jsonb_build_object('id',management_row.id,'propertyId',NEW.property_id,'xmin',management_xmin,'tuple',management_tuple)
  THEN RAISE EXCEPTION 'onboarding Management Agreement requires its actual native canonical source'; END IF;
  -- Lock actual current versions before comparing identity-only source witnesses. Values and reasons remain encrypted.
  PERFORM id FROM config_rule WHERE organization_id=NEW.organization_id AND id IN(SELECT heads.id FROM (SELECT DISTINCT ON(key) id,key,version,lifecycle,created_by,xmin::text AS row_xmin,ctid::text AS row_tuple FROM config_rule WHERE organization_id=NEW.organization_id AND scope_type='agreement' AND scope_id=management_row.id AND archived_at IS NULL AND key=ANY(ARRAY['finance.commission','finance.expense_treatment','finance.approval_thresholds','finance.payout_schedule','agreement.responsibilities','agreement.notice','agreement.special_conditions']::text[]) ORDER BY key,version DESC) heads) ORDER BY id FOR UPDATE;
  SELECT count(*),coalesce(bool_and(heads.lifecycle IN('DRAFT','ACTIVE') AND heads.created_by IS NOT NULL),false),
   coalesce(bool_and(heads.lifecycle='DRAFT' AND heads.version=1 AND heads.created_by=NEW.created_by AND heads.row_xmin=pg_current_xact_id()::xid::text),false),
   coalesce(jsonb_agg(jsonb_build_object('id',heads.id,'key',heads.key,'version',heads.version,'scopeType','agreement','scopeId',management_row.id,'xmin',heads.row_xmin,'tuple',heads.row_tuple) ORDER BY heads.key),'[]'::jsonb)
   INTO management_count,management_rules_valid,management_birth_valid,management_rules FROM (SELECT DISTINCT ON(key) id,key,version,lifecycle,created_by,xmin::text AS row_xmin,ctid::text AS row_tuple FROM config_rule WHERE organization_id=NEW.organization_id AND scope_type='agreement' AND scope_id=management_row.id AND archived_at IS NULL AND key=ANY(ARRAY['finance.commission','finance.expense_treatment','finance.approval_thresholds','finance.payout_schedule','agreement.responsibilities','agreement.notice','agreement.special_conditions']::text[]) ORDER BY key,version DESC) heads;
  IF management_count<>7 OR NOT management_rules_valid OR NEW.source_snapshot->'rules' IS DISTINCT FROM management_rules
  THEN RAISE EXCEPTION 'onboarding Management Agreement requires all seven actual registered configuration version pins'; END IF;
  IF NEW.mode='CREATE' THEN
   IF NEW.source_snapshot-ARRAY['source','parent','agreement','rules','inputFingerprint']<>'{}'::jsonb
    OR NOT coalesce(NEW.source_snapshot->>'inputFingerprint' ~ '^[a-f0-9]{64}$',false)
    OR management_row.status<>'DRAFT' OR management_row.created_by IS DISTINCT FROM NEW.created_by
    OR management_xmin IS DISTINCT FROM pg_current_xact_id()::xid::text OR NOT management_birth_valid
    OR NOT EXISTS(SELECT 1 FROM audit_log a WHERE a.organization_id=NEW.organization_id AND a.actor_id=NEW.created_by AND a.action='owner_agreement.changed'
     AND a.resource_type='property' AND a.resource_id=NEW.property_id AND a.property_scope_id=NEW.property_id AND a.request_id=NEW.request_id
     AND a.after->>'id'=management_row.id::text AND a.xmin::text=pg_current_xact_id()::xid::text)
   THEN RAISE EXCEPTION 'onboarding Management Agreement requires atomic canonical DRAFT creation, original rules and audit'; END IF;
  ELSIF NEW.source_snapshot-ARRAY['source','parent','agreement','rules']<>'{}'::jsonb THEN
   RAISE EXCEPTION 'linked onboarding Management Agreement cannot invent financial inputs or plaintext private values';
  END IF;
 END IF;
 RETURN NEW;
END $$;

COMMIT;
