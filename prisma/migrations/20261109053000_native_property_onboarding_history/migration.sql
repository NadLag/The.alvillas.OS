BEGIN;

CREATE TABLE property_onboarding_session (
 id UUID NOT NULL DEFAULT app_uuid_v7(),organization_id UUID NOT NULL,created_by UUID NOT NULL,
 created_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,request_id TEXT NOT NULL,
 CONSTRAINT property_onboarding_session_pkey PRIMARY KEY(id),
 CONSTRAINT property_onboarding_session_org_fk FOREIGN KEY(organization_id) REFERENCES organization(id) ON DELETE RESTRICT ON UPDATE NO ACTION,
 CONSTRAINT property_onboarding_session_creator_fk FOREIGN KEY(organization_id,created_by) REFERENCES user_account(organization_id,id) ON DELETE RESTRICT ON UPDATE NO ACTION,
 CONSTRAINT property_onboarding_session_shape CHECK(isfinite(created_at) AND length(request_id) BETWEEN 1 AND 1000)
);
CREATE UNIQUE INDEX property_onboarding_session_org_id_key ON property_onboarding_session(organization_id,id);
CREATE INDEX property_onboarding_session_org_created_idx ON property_onboarding_session(organization_id,created_at,id);

CREATE TABLE property_onboarding_revision (
 id UUID NOT NULL DEFAULT app_uuid_v7(),organization_id UUID NOT NULL,session_id UUID NOT NULL,previous_id UUID,number INTEGER NOT NULL,
 step TEXT NOT NULL,owner_id UUID NOT NULL,property_id UUID,mode TEXT NOT NULL,
 created_by UUID NOT NULL,created_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 command_key UUID NOT NULL,command_hash TEXT NOT NULL,review_fingerprint TEXT NOT NULL,source_fingerprint TEXT NOT NULL,source_snapshot JSONB NOT NULL,
 payload_schema_version INTEGER NOT NULL DEFAULT 1,encrypted_payload BYTEA NOT NULL,payload_sha256 TEXT NOT NULL,
 policy_id UUID NOT NULL,policy_version INTEGER NOT NULL,policy_snapshot JSONB NOT NULL,authorization_cap JSONB NOT NULL,request_id TEXT NOT NULL,
 CONSTRAINT property_onboarding_revision_pkey PRIMARY KEY(id),
 CONSTRAINT property_onboarding_revision_org_fk FOREIGN KEY(organization_id) REFERENCES organization(id) ON DELETE RESTRICT ON UPDATE NO ACTION,
 CONSTRAINT property_onboarding_revision_session_fk FOREIGN KEY(organization_id,session_id) REFERENCES property_onboarding_session(organization_id,id) ON DELETE RESTRICT ON UPDATE NO ACTION,
 CONSTRAINT property_onboarding_revision_owner_fk FOREIGN KEY(organization_id,owner_id) REFERENCES owner(organization_id,id) ON DELETE RESTRICT ON UPDATE NO ACTION,
 CONSTRAINT property_onboarding_revision_property_fk FOREIGN KEY(organization_id,property_id) REFERENCES property(organization_id,id) ON DELETE RESTRICT ON UPDATE NO ACTION,
 CONSTRAINT property_onboarding_revision_creator_fk FOREIGN KEY(organization_id,created_by) REFERENCES user_account(organization_id,id) ON DELETE RESTRICT ON UPDATE NO ACTION,
 CONSTRAINT property_onboarding_revision_policy_fk FOREIGN KEY(organization_id,policy_id) REFERENCES config_rule(organization_id,id) ON DELETE RESTRICT ON UPDATE NO ACTION,
 CONSTRAINT property_onboarding_revision_shape CHECK(coalesce(number>0 AND step='OWNER' AND property_id IS NULL AND mode IN('CREATE','LINK')
  AND isfinite(created_at) AND payload_schema_version=1 AND octet_length(encrypted_payload) BETWEEN 64 AND 66304
  AND command_hash ~ '^[a-f0-9]{64}$' AND review_fingerprint ~ '^[a-f0-9]{64}$' AND source_fingerprint ~ '^[a-f0-9]{64}$'
  AND payload_sha256=encode(sha256(encrypted_payload),'hex') AND policy_version>0
  AND jsonb_typeof(source_snapshot)='object' AND jsonb_typeof(policy_snapshot)='object' AND jsonb_typeof(authorization_cap)='object'
  AND length(request_id) BETWEEN 1 AND 1000,false))
);
CREATE UNIQUE INDEX property_onboarding_revision_org_id_key ON property_onboarding_revision(organization_id,id);
CREATE UNIQUE INDEX property_onboarding_revision_org_session_id_key ON property_onboarding_revision(organization_id,session_id,id);
CREATE UNIQUE INDEX property_onboarding_revision_org_number_key ON property_onboarding_revision(organization_id,session_id,number);
CREATE UNIQUE INDEX property_onboarding_revision_org_command_key ON property_onboarding_revision(organization_id,command_key);
CREATE INDEX property_onboarding_revision_org_history_idx ON property_onboarding_revision(organization_id,session_id,number DESC);
CREATE INDEX property_onboarding_revision_org_owner_idx ON property_onboarding_revision(organization_id,owner_id,created_at,id);
ALTER TABLE property_onboarding_revision ADD CONSTRAINT property_onboarding_revision_previous_fk FOREIGN KEY(organization_id,session_id,previous_id)
 REFERENCES property_onboarding_revision(organization_id,session_id,id) ON DELETE RESTRICT ON UPDATE NO ACTION;

ALTER TABLE property_onboarding_session ENABLE ROW LEVEL SECURITY;
ALTER TABLE property_onboarding_session FORCE ROW LEVEL SECURITY;
CREATE POLICY property_onboarding_session_tenant_isolation ON property_onboarding_session
 USING(organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid)
 WITH CHECK(organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid);
ALTER TABLE property_onboarding_revision ENABLE ROW LEVEL SECURITY;
ALTER TABLE property_onboarding_revision FORCE ROW LEVEL SECURITY;
CREATE POLICY property_onboarding_revision_tenant_isolation ON property_onboarding_revision
 USING(organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid)
 WITH CHECK(organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid);

CREATE FUNCTION app_onboarding_append_only() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN RAISE EXCEPTION 'native_onboarding_history_immutable'; END $$;
CREATE TRIGGER property_onboarding_session_immutable BEFORE UPDATE OR DELETE ON property_onboarding_session FOR EACH ROW EXECUTE FUNCTION app_onboarding_append_only();
CREATE TRIGGER property_onboarding_revision_immutable BEFORE UPDATE OR DELETE ON property_onboarding_revision FOR EACH ROW EXECUTE FUNCTION app_onboarding_append_only();

CREATE FUNCTION app_guard_onboarding_revision() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE original property_onboarding_session%ROWTYPE;previous property_onboarding_revision%ROWTYPE;target owner%ROWTYPE;owner_xmin TEXT;owner_tuple TEXT;rule config_rule%ROWTYPE;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended(NEW.organization_id::text||':onboarding:session:'||NEW.session_id::text,0));
 SELECT * INTO original FROM property_onboarding_session WHERE organization_id=NEW.organization_id AND id=NEW.session_id;
 SELECT * INTO previous FROM property_onboarding_revision WHERE organization_id=NEW.organization_id AND session_id=NEW.session_id ORDER BY number DESC LIMIT 1;
 IF original.id IS NULL OR NEW.previous_id IS DISTINCT FROM previous.id OR NEW.number<>coalesce(previous.number,0)+1
  OR NEW.created_at<original.created_at OR (previous.id IS NOT NULL AND NEW.created_at<previous.created_at)
  OR (previous.id IS NULL AND (original.created_by<>NEW.created_by OR original.created_at<>NEW.created_at OR original.request_id<>NEW.request_id))
 THEN RAISE EXCEPTION 'onboarding requires its actual consecutive native session head'; END IF;
 SELECT * INTO target FROM owner WHERE organization_id=NEW.organization_id AND id=NEW.owner_id AND archived_at IS NULL FOR UPDATE;
 SELECT xmin::text,ctid::text INTO owner_xmin,owner_tuple FROM owner WHERE organization_id=NEW.organization_id AND id=NEW.owner_id;
 IF target.id IS NULL OR NEW.source_snapshot->>'source' IS DISTINCT FROM 'CORE_OWNER_IDENTITY'
  OR NEW.source_snapshot->>'ownerId' IS DISTINCT FROM target.id::text OR NEW.source_snapshot->>'ownerXmin' IS DISTINCT FROM owner_xmin
  OR NEW.source_snapshot->>'ownerTuple' IS DISTINCT FROM owner_tuple
  OR (NEW.source_snapshot->>'ownerCreatedAt')::timestamptz IS DISTINCT FROM date_trunc('milliseconds',target.created_at)
  OR (NEW.source_snapshot->>'ownerUpdatedAt')::timestamptz IS DISTINCT FROM date_trunc('milliseconds',target.updated_at)
  OR NEW.source_snapshot-ARRAY['source','ownerId','ownerXmin','ownerTuple','ownerCreatedAt','ownerUpdatedAt']<>'{}'::jsonb
 THEN RAISE EXCEPTION 'onboarding requires its actual active canonical owner source'; END IF;
 IF NEW.mode='CREATE' AND (target.created_by IS DISTINCT FROM NEW.created_by OR owner_xmin IS DISTINCT FROM pg_current_xact_id()::xid::text
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
  OR NOT coalesce(rule.value->'owner_modes' ? NEW.mode,false)
 THEN RAISE EXCEPTION 'onboarding requires its actual approved organization policy'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER property_onboarding_revision_native_guard BEFORE INSERT ON property_onboarding_revision FOR EACH ROW EXECUTE FUNCTION app_guard_onboarding_revision();

CREATE FUNCTION app_guard_onboarding_revision_events() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM audit_log a WHERE a.organization_id=NEW.organization_id AND a.actor_id=NEW.created_by
  AND a.action='onboarding.step_recorded' AND a.resource_type='onboarding' AND a.resource_id=NEW.session_id AND a.request_id=NEW.request_id
  AND a.occurred_at=NEW.created_at AND a.xmin::text=NEW.xmin::text AND a.xmin::text=pg_current_xact_id()::xid::text
  AND a.after=jsonb_build_object('sessionId',NEW.session_id,'revisionId',NEW.id,'previousRevisionId',NEW.previous_id,'number',NEW.number,'step',NEW.step,
   'ownerId',NEW.owner_id,'propertyId',NEW.property_id,'mode',NEW.mode,'commandHash',NEW.command_hash,'payloadSha256',NEW.payload_sha256,
   'sourceFingerprint',NEW.source_fingerprint,'reviewFingerprint',NEW.review_fingerprint,'policyId',NEW.policy_id))
 THEN RAISE EXCEPTION 'onboarding requires its atomic private actor audit'; END IF;
 IF NOT EXISTS(SELECT 1 FROM outbox_event e WHERE e.organization_id=NEW.organization_id AND e.type='onboarding.step_recorded'
  AND e.idempotency_key='onboarding.step:'||NEW.id::text AND e.occurred_at=NEW.created_at AND e.xmin::text=NEW.xmin::text
  AND e.payload=jsonb_build_object('sessionId',NEW.session_id,'revisionId',NEW.id,'step',NEW.step,'ownerId',NEW.owner_id,'propertyId',NEW.property_id))
 THEN RAISE EXCEPTION 'onboarding requires its atomic identifier-only outbox'; END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER property_onboarding_revision_events_guard AFTER INSERT ON property_onboarding_revision
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app_guard_onboarding_revision_events();

CREATE FUNCTION app_guard_onboarding_session() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM property_onboarding_revision r WHERE r.organization_id=NEW.organization_id AND r.session_id=NEW.id
  AND r.number=1 AND r.previous_id IS NULL AND r.created_by=NEW.created_by AND r.created_at=NEW.created_at AND r.request_id=NEW.request_id
  AND r.xmin::text=NEW.xmin::text)
 THEN RAISE EXCEPTION 'onboarding session requires its atomic first native step'; END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER property_onboarding_session_birth_guard AFTER INSERT ON property_onboarding_session
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app_guard_onboarding_session();

-- Match the existing standard administrator catalog without granting ordinary operational roles access.
DO $$ DECLARE organization_uuid UUID; BEGIN
 FOR organization_uuid IN SELECT id FROM organization LOOP
  PERFORM set_config('app.current_organization_id',organization_uuid::text,true);
  INSERT INTO permission(organization_id,key,resource,action,description)
  SELECT organization_uuid,'onboarding:'||action,'onboarding',action,action||' onboarding'
  FROM unnest(ARRAY['view','create','edit','void','approve','reject','assign','validate','export','pay','reconcile','configure','override']) action
  ON CONFLICT(organization_id,key) DO NOTHING;
  INSERT INTO role_permission(organization_id,role_id,permission_id)
  SELECT organization_uuid,r.id,p.id FROM role r JOIN permission p ON p.organization_id=r.organization_id
  WHERE r.organization_id=organization_uuid AND r.key='admin' AND r.is_system AND r.archived_at IS NULL AND p.resource='onboarding'
  ON CONFLICT(organization_id,role_id,permission_id) DO NOTHING;
 END LOOP;
END $$;

COMMIT;
