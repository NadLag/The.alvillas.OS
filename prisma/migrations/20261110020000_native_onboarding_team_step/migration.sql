BEGIN;

-- Extend only the closed native shape. Every original step and its guards remain unchanged.
ALTER TABLE property_onboarding_revision DROP CONSTRAINT property_onboarding_revision_shape;
ALTER TABLE property_onboarding_revision ADD CONSTRAINT property_onboarding_revision_shape CHECK(coalesce(number>0
 AND ((step='OWNER' AND property_id IS NULL AND mode IN('CREATE','LINK'))
  OR (step='PROPERTY' AND property_id IS NOT NULL AND previous_id IS NOT NULL AND number>1 AND mode IN('CREATE','LINK'))
  OR (step='OPERATING_PROFILE' AND property_id IS NOT NULL AND previous_id IS NOT NULL AND number>2 AND mode IN('LINK','UPDATE'))
  OR (step='MANAGEMENT_AGREEMENT' AND property_id IS NOT NULL AND previous_id IS NOT NULL AND number>3 AND mode IN('CREATE','LINK'))
  OR (step='TEAM' AND property_id IS NOT NULL AND previous_id IS NOT NULL AND number>4 AND mode IN('LINK','ASSIGN')))
 AND isfinite(created_at) AND payload_schema_version=1 AND octet_length(encrypted_payload) BETWEEN 64 AND (CASE WHEN step='OWNER' THEN 66304 ELSE 196608 END)
 AND command_hash ~ '^[a-f0-9]{64}$' AND review_fingerprint ~ '^[a-f0-9]{64}$' AND source_fingerprint ~ '^[a-f0-9]{64}$'
 AND payload_sha256=encode(sha256(encrypted_payload),'hex') AND policy_version>0
 AND jsonb_typeof(source_snapshot)='object' AND jsonb_typeof(policy_snapshot)='object' AND jsonb_typeof(authorization_cap)='object'
 AND length(request_id) BETWEEN 1 AND 1000,false));

-- The existing native guard deliberately returns unknown steps to the closed shape constraint.
-- Its complete behavior for Owner, Property, Operating Profile and Management Agreement is retained.
CREATE FUNCTION app_guard_onboarding_team_revision() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE original property_onboarding_session%ROWTYPE;previous property_onboarding_revision%ROWTYPE;
 target owner%ROWTYPE;property_row property%ROWTYPE;rule config_rule%ROWTYPE;team_policy JSONB;minimum_assignments NUMERIC;
 owner_source JSONB;parent_source JSONB;property_source JSONB;ownership_source JSONB;
 owner_xmin TEXT;owner_tuple TEXT;property_xmin TEXT;property_tuple TEXT;
 actual_assignments JSONB;actual_people JSONB;actual_accounts JSONB;actual_roles JSONB;
 assignment_count INTEGER;people_count INTEGER;accounts_count INTEGER;roles_count INTEGER;
 required_people INTEGER;required_accounts INTEGER;required_roles INTEGER;assignments_born_here BOOLEAN;roles_valid BOOLEAN;
BEGIN
 IF NEW.step IS DISTINCT FROM 'TEAM' THEN RETURN NEW; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(NEW.organization_id::text||':onboarding:session:'||NEW.session_id::text,0));
 SELECT * INTO original FROM property_onboarding_session WHERE organization_id=NEW.organization_id AND id=NEW.session_id;
 SELECT * INTO previous FROM property_onboarding_revision WHERE organization_id=NEW.organization_id AND session_id=NEW.session_id ORDER BY number DESC LIMIT 1;
 IF original.id IS NULL OR previous.id IS NULL OR previous.step NOT IN('MANAGEMENT_AGREEMENT','TEAM')
  OR NEW.previous_id IS DISTINCT FROM previous.id OR NEW.number<>previous.number+1
  OR NEW.owner_id IS DISTINCT FROM previous.owner_id OR NEW.property_id IS DISTINCT FROM previous.property_id
  OR NEW.created_at<original.created_at OR NEW.created_at<previous.created_at
 THEN RAISE EXCEPTION 'onboarding Team requires its actual consecutive saved Management Agreement predecessor'; END IF;
 IF NOT EXISTS(SELECT 1 FROM user_account WHERE organization_id=NEW.organization_id AND id=NEW.created_by AND status='ACTIVE' AND person_id IS NOT NULL)
 THEN RAISE EXCEPTION 'onboarding Team requires its actual active account and Person'; END IF;

 SELECT * INTO rule FROM config_rule WHERE organization_id=NEW.organization_id AND id=NEW.policy_id FOR UPDATE;
 IF rule.id IS NULL OR rule.created_by IS NULL OR rule.key<>'onboarding.wizard' OR rule.scope_type<>'organization' OR rule.scope_id IS NOT NULL
  OR rule.archived_at IS NOT NULL OR rule.lifecycle NOT IN('ACTIVE','RETIRED') OR NEW.created_at<rule.effective_from OR (rule.effective_to IS NOT NULL AND NEW.created_at>=rule.effective_to)
  OR NEW.policy_version<>rule.version OR NEW.policy_snapshot IS DISTINCT FROM jsonb_build_object('id',rule.id,'version',rule.version,'value',rule.value)
  OR rule.value->>'source' IS DISTINCT FROM 'NATIVE_REVIEWED_PROPERTY_ONBOARDING'
  OR rule.value->>'history' IS DISTINCT FROM 'APPEND_ONLY_NATIVE_ONBOARDING_STEPS' OR rule.value->>'progress' IS DISTINCT FROM 'DERIVED_FROM_NATIVE_RECORDS'
  OR rule.value->>'encryption' IS DISTINCT FROM 'APP_MANAGED_AUTHENTICATED_ENCRYPTION' OR rule.value->>'release' IS DISTINCT FROM 'NATIVE_DELIVERY_READINESS'
 THEN RAISE EXCEPTION 'onboarding Team requires its actual approved organization policy'; END IF;
 team_policy:=rule.value->'team';
 IF jsonb_typeof(team_policy) IS DISTINCT FROM 'object' OR team_policy-ARRAY['modes','minimum_assignments']<>'{}'::jsonb
  OR jsonb_typeof(team_policy->'modes') IS DISTINCT FROM 'array' OR jsonb_typeof(team_policy->'minimum_assignments') IS DISTINCT FROM 'number'
 THEN RAISE EXCEPTION 'onboarding Team requires explicit approved modes and minimum'; END IF;
 minimum_assignments:=(team_policy->>'minimum_assignments')::numeric;
 IF minimum_assignments<0 OR minimum_assignments>20 OR minimum_assignments<>trunc(minimum_assignments)
  OR jsonb_array_length(team_policy->'modes') NOT BETWEEN 1 AND 2
  OR (SELECT count(DISTINCT value) FROM jsonb_array_elements(team_policy->'modes'))<>jsonb_array_length(team_policy->'modes')
  OR EXISTS(SELECT 1 FROM jsonb_array_elements_text(team_policy->'modes') item WHERE item NOT IN('LINK','ASSIGN'))
  OR NOT coalesce(team_policy->'modes' ? NEW.mode,false)
 THEN RAISE EXCEPTION 'onboarding Team requires its actual enabled mode and configured minimum'; END IF;

 IF NEW.source_snapshot->>'source' IS DISTINCT FROM 'CORE_PROPERTY_TEAM'
  OR jsonb_typeof(NEW.source_snapshot->'assignments') IS DISTINCT FROM 'array'
  OR jsonb_typeof(NEW.source_snapshot->'people') IS DISTINCT FROM 'array'
  OR jsonb_typeof(NEW.source_snapshot->'accounts') IS DISTINCT FROM 'array'
  OR jsonb_typeof(NEW.source_snapshot->'roles') IS DISTINCT FROM 'array'
 THEN RAISE EXCEPTION 'onboarding Team requires actual identity-only canonical source manifests'; END IF;
 IF jsonb_array_length(NEW.source_snapshot->'assignments')>20 OR jsonb_array_length(NEW.source_snapshot->'people')>20
  OR jsonb_array_length(NEW.source_snapshot->'accounts')>20 OR jsonb_array_length(NEW.source_snapshot->'roles')>20
  OR jsonb_array_length(NEW.source_snapshot->'assignments')<minimum_assignments
  OR (NEW.mode='ASSIGN' AND jsonb_array_length(NEW.source_snapshot->'assignments')=0)
 THEN RAISE EXCEPTION 'onboarding Team must satisfy its configured minimum and bounded native batch'; END IF;
 IF NEW.mode='ASSIGN' THEN
  IF NEW.source_snapshot-ARRAY['source','parent','assignments','people','accounts','roles','inputFingerprint']<>'{}'::jsonb
   OR NOT coalesce(NEW.source_snapshot->>'inputFingerprint' ~ '^[a-f0-9]{64}$',false)
  THEN RAISE EXCEPTION 'assigned onboarding Team requires its exact private input fingerprint'; END IF;
 ELSIF NEW.source_snapshot-ARRAY['source','parent','assignments','people','accounts','roles']<>'{}'::jsonb THEN
  RAISE EXCEPTION 'linked onboarding Team cannot invent inputs or plaintext private values';
 END IF;

 parent_source:=NEW.source_snapshot->'parent';owner_source:=parent_source->'owner';property_source:=parent_source->'property';
 SELECT * INTO target FROM owner WHERE organization_id=NEW.organization_id AND id=NEW.owner_id AND archived_at IS NULL FOR UPDATE;
 SELECT xmin::text,ctid::text INTO owner_xmin,owner_tuple FROM owner WHERE organization_id=NEW.organization_id AND id=NEW.owner_id;
 IF target.id IS NULL OR owner_source->>'source' IS DISTINCT FROM 'CORE_OWNER_IDENTITY'
  OR owner_source->>'ownerId' IS DISTINCT FROM target.id::text OR owner_source->>'ownerXmin' IS DISTINCT FROM owner_xmin OR owner_source->>'ownerTuple' IS DISTINCT FROM owner_tuple
  OR (owner_source->>'ownerCreatedAt')::timestamptz IS DISTINCT FROM date_trunc('milliseconds',target.created_at)
  OR (owner_source->>'ownerUpdatedAt')::timestamptz IS DISTINCT FROM date_trunc('milliseconds',target.updated_at)
  OR owner_source-ARRAY['source','ownerId','ownerXmin','ownerTuple','ownerCreatedAt','ownerUpdatedAt']<>'{}'::jsonb
 THEN RAISE EXCEPTION 'onboarding Team requires its actual active canonical Owner source'; END IF;
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
 THEN RAISE EXCEPTION 'onboarding Team requires its actual physical, ownership and operating predecessor sources'; END IF;

 -- Lock Person sources in the same stable order used by the canonical Team batch writer.
 PERFORM id FROM person WHERE organization_id=NEW.organization_id AND id IN(SELECT (item->>'personId')::uuid FROM jsonb_array_elements(NEW.source_snapshot->'assignments') item) ORDER BY id FOR UPDATE;
 PERFORM id FROM role_assignment WHERE organization_id=NEW.organization_id AND id IN(SELECT (item->>'id')::uuid FROM jsonb_array_elements(NEW.source_snapshot->'assignments') item) ORDER BY id FOR UPDATE;
 PERFORM id FROM role WHERE organization_id=NEW.organization_id AND id IN(SELECT (item->>'roleId')::uuid FROM jsonb_array_elements(NEW.source_snapshot->'assignments') item) ORDER BY id FOR UPDATE;
 PERFORM rp.role_id FROM role_permission rp WHERE rp.organization_id=NEW.organization_id AND rp.role_id IN(SELECT (item->>'roleId')::uuid FROM jsonb_array_elements(NEW.source_snapshot->'assignments') item) ORDER BY rp.role_id,rp.permission_id FOR UPDATE;
 SELECT count(*)::int,count(DISTINCT a.person_id)::int,count(DISTINCT a.user_account_id)::int,count(DISTINCT a.role_id)::int,
  coalesce(bool_and(a.created_by IS NOT DISTINCT FROM NEW.created_by AND a.xmin::text=pg_current_xact_id()::xid::text),false),
  coalesce(jsonb_agg(jsonb_build_object('id',a.id,'rowVersion',a.xmin::text,'tuple',a.ctid::text,'personId',a.person_id,'roleId',a.role_id,'userAccountId',a.user_account_id,'scopeType',a.scope_type,'scopeId',a.scope_id) ORDER BY a.id),'[]'::jsonb)
  INTO assignment_count,required_people,required_accounts,required_roles,assignments_born_here,actual_assignments
  FROM role_assignment a WHERE a.organization_id=NEW.organization_id AND a.id IN(SELECT (item->>'id')::uuid FROM jsonb_array_elements(NEW.source_snapshot->'assignments') item)
   AND a.scope_type='property' AND a.scope_id=NEW.property_id AND a.archived_at IS NULL;
 IF assignment_count<>jsonb_array_length(NEW.source_snapshot->'assignments') OR actual_assignments IS DISTINCT FROM NEW.source_snapshot->'assignments'
 THEN RAISE EXCEPTION 'onboarding Team requires its exact current canonical Property assignment identities and versions'; END IF;
 SELECT count(*)::int,coalesce(jsonb_agg(jsonb_build_object('id',p.id,'rowVersion',p.xmin::text,'tuple',p.ctid::text) ORDER BY p.id),'[]'::jsonb)
  INTO people_count,actual_people FROM person p WHERE p.organization_id=NEW.organization_id AND p.archived_at IS NULL
   AND p.id IN(SELECT (item->>'personId')::uuid FROM jsonb_array_elements(actual_assignments) item);
 SELECT count(*)::int,coalesce(jsonb_agg(jsonb_build_object('id',a.id,'rowVersion',a.xmin::text,'tuple',a.ctid::text,'personId',a.person_id) ORDER BY a.id),'[]'::jsonb)
  INTO accounts_count,actual_accounts FROM user_account a WHERE a.organization_id=NEW.organization_id
   AND a.id IN(SELECT (item->>'userAccountId')::uuid FROM jsonb_array_elements(actual_assignments) item)
   AND (NEW.mode<>'ASSIGN' OR a.status='ACTIVE');
 SELECT count(*)::int,coalesce(bool_and(coalesce(witness.valid,true)),true),
  coalesce(jsonb_agg(jsonb_build_object('id',r.id,'rowVersion',r.xmin::text,'tuple',r.ctid::text,'permissionsHash',coalesce(witness.signature,md5('')),'permissionCount',coalesce(witness.total,0)::int) ORDER BY r.id),'[]'::jsonb)
  INTO roles_count,roles_valid,actual_roles FROM role r LEFT JOIN LATERAL (
   SELECT md5(string_agg(rp.permission_id::text||':'||rp.xmin::text||':'||rp.ctid::text||':'||coalesce(p.key,'MISSING')||':'||coalesce(p.resource,'MISSING')||':'||coalesce(p.action,'MISSING')||':'||coalesce(p.xmin::text,'MISSING')||':'||coalesce(p.ctid::text,'MISSING'),'|' ORDER BY rp.permission_id)) AS signature,count(*)::int AS total,bool_and(p.id IS NOT NULL) AS valid
   FROM role_permission rp LEFT JOIN permission p ON p.organization_id=rp.organization_id AND p.id=rp.permission_id
   WHERE rp.organization_id=r.organization_id AND rp.role_id=r.id
  ) witness ON true WHERE r.organization_id=NEW.organization_id AND r.archived_at IS NULL
   AND r.id IN(SELECT (item->>'roleId')::uuid FROM jsonb_array_elements(actual_assignments) item);
 IF people_count<>required_people OR accounts_count<>required_accounts OR roles_count<>required_roles OR NOT roles_valid
  OR actual_people IS DISTINCT FROM NEW.source_snapshot->'people' OR actual_accounts IS DISTINCT FROM NEW.source_snapshot->'accounts' OR actual_roles IS DISTINCT FROM NEW.source_snapshot->'roles'
  OR EXISTS(SELECT 1 FROM role_assignment a JOIN user_account account ON account.organization_id=a.organization_id AND account.id=a.user_account_id
   WHERE a.organization_id=NEW.organization_id AND a.id IN(SELECT (item->>'id')::uuid FROM jsonb_array_elements(actual_assignments) item) AND account.person_id IS DISTINCT FROM a.person_id)
 THEN RAISE EXCEPTION 'onboarding Team requires its exact active Person, Account and Role source graph and permission witnesses'; END IF;
 IF NEW.mode='ASSIGN' AND (NOT assignments_born_here OR EXISTS(
  SELECT 1 FROM role_assignment a WHERE a.organization_id=NEW.organization_id AND a.id IN(SELECT (item->>'id')::uuid FROM jsonb_array_elements(actual_assignments) item)
   AND NOT EXISTS(SELECT 1 FROM audit_log event WHERE event.organization_id=NEW.organization_id AND event.actor_id=NEW.created_by
    AND event.action='team.assignment.create' AND event.resource_type='team_member' AND event.resource_id=a.id
    AND event.property_scope_id=NEW.property_id AND event.request_id=NEW.request_id AND event.xmin::text=pg_current_xact_id()::xid::text)))
 THEN RAISE EXCEPTION 'onboarding Team requires every atomic canonical assignment and its original attributed audit'; END IF;
 RETURN NEW;
END $$;

CREATE TRIGGER property_onboarding_team_native_guard BEFORE INSERT ON property_onboarding_revision
 FOR EACH ROW EXECUTE FUNCTION app_guard_onboarding_team_revision();

COMMIT;
