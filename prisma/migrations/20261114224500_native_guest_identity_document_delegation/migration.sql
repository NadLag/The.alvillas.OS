BEGIN;
-- A separate signed delegation retains actual document authority without rewriting existing form grants.
CREATE TABLE guest_hub_identity_document_delegation (
 organization_id UUID NOT NULL,
 grant_id UUID NOT NULL,
 archive_policy_id UUID NOT NULL,
 archive_policy_version INTEGER NOT NULL,
 archive_policy_snapshot JSONB NOT NULL,
 retention_policy_id UUID NOT NULL,
 retention_policy_version INTEGER NOT NULL,
 retention_policy_snapshot JSONB NOT NULL,
 signature_version TEXT NOT NULL,
 signature TEXT NOT NULL,
 created_at TIMESTAMPTZ(6) NOT NULL,
 CONSTRAINT guest_identity_delegation_pkey PRIMARY KEY (organization_id,grant_id),
 CONSTRAINT guest_identity_delegation_organization_fk FOREIGN KEY (organization_id) REFERENCES organization(id) ON DELETE RESTRICT ON UPDATE NO ACTION,
 CONSTRAINT guest_identity_delegation_grant_fk FOREIGN KEY (organization_id,grant_id) REFERENCES guest_hub_form_grant(organization_id,id) ON DELETE RESTRICT ON UPDATE NO ACTION,
 CONSTRAINT guest_identity_delegation_archive_fk FOREIGN KEY (organization_id,archive_policy_id) REFERENCES config_rule(organization_id,id) ON DELETE RESTRICT ON UPDATE NO ACTION,
 CONSTRAINT guest_identity_delegation_retention_fk FOREIGN KEY (organization_id,retention_policy_id) REFERENCES config_rule(organization_id,id) ON DELETE RESTRICT ON UPDATE NO ACTION,
 CONSTRAINT guest_identity_delegation_shape CHECK(coalesce(
  archive_policy_version>0 AND retention_policy_version>0 AND isfinite(created_at) AND created_at=date_trunc('milliseconds',created_at)
  AND signature ~ '^[a-f0-9]{64}$' AND length(signature_version) BETWEEN 1 AND 120
  AND archive_policy_snapshot-ARRAY['organizationId','id','version','value']='{}'::jsonb
  AND retention_policy_snapshot-ARRAY['organizationId','id','version','value']='{}'::jsonb
  AND archive_policy_snapshot->>'organizationId'=organization_id::text AND archive_policy_snapshot->>'id'=archive_policy_id::text AND archive_policy_snapshot->>'version'=archive_policy_version::text
  AND retention_policy_snapshot->>'organizationId'=organization_id::text AND retention_policy_snapshot->>'id'=retention_policy_id::text AND retention_policy_snapshot->>'version'=retention_policy_version::text
  AND jsonb_typeof(archive_policy_snapshot->'value')='object' AND jsonb_typeof(retention_policy_snapshot->'value')='object'
 ,false))
);
CREATE INDEX guest_identity_delegation_archive_idx ON guest_hub_identity_document_delegation(organization_id,archive_policy_id);
CREATE INDEX guest_identity_delegation_retention_idx ON guest_hub_identity_document_delegation(organization_id,retention_policy_id);
ALTER TABLE guest_hub_identity_document_delegation ENABLE ROW LEVEL SECURITY;
ALTER TABLE guest_hub_identity_document_delegation FORCE ROW LEVEL SECURITY;
CREATE POLICY guest_identity_delegation_tenant_isolation ON guest_hub_identity_document_delegation
 USING(organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid)
 WITH CHECK(organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid);
CREATE TRIGGER guest_identity_delegation_immutable BEFORE UPDATE OR DELETE ON guest_hub_identity_document_delegation FOR EACH ROW EXECUTE FUNCTION app_onboarding_append_only();

CREATE FUNCTION app_guest_identity_delegated_policy(org UUID,res UUID,policy_id UUID,policy_version INTEGER,snapshot JSONB,policy_key TEXT,at_time TIMESTAMPTZ) RETURNS BOOLEAN LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE rule config_rule%ROWTYPE;r reservation%ROWTYPE;p property%ROWTYPE;
BEGIN
 SELECT * INTO rule FROM config_rule WHERE organization_id=org AND id=policy_id FOR SHARE;
 SELECT * INTO r FROM reservation WHERE organization_id=org AND id=res;
 SELECT * INTO p FROM property WHERE organization_id=org AND id=r.property_id;
 RETURN coalesce(rule.id IS NOT NULL AND r.id IS NOT NULL AND p.id IS NOT NULL AND policy_key IN('documents.archive','documents.retention') AND rule.key=policy_key AND rule.lifecycle='ACTIVE'
  AND rule.version=policy_version AND snapshot=jsonb_build_object('organizationId',org::text,'id',rule.id::text,'version',rule.version,'value',rule.value)
  AND rule.effective_from<=at_time AND (rule.effective_to IS NULL OR rule.effective_to>at_time)
  AND (rule.scope_type='organization' AND rule.scope_id IS NULL OR policy_key='documents.archive' AND (rule.scope_type='property' AND rule.scope_id=p.id OR rule.scope_type='city' AND rule.scope_id=p.city_id)),false);
END $$;
CREATE FUNCTION app_guard_guest_identity_delegation_native() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE original guest_hub_form_grant%ROWTYPE;
BEGIN
 SELECT * INTO original FROM guest_hub_form_grant WHERE organization_id=NEW.organization_id AND id=NEW.grant_id FOR SHARE;
 IF NOT coalesce(original.id IS NOT NULL AND original.form_key='IDENTITY_DOCUMENTS' AND original.decision='GRANTED' AND NEW.created_at=original.created_at
  AND original.xmin::text=pg_current_xact_id()::xid::text
  AND app_guest_identity_delegated_policy(NEW.organization_id,original.reservation_id,NEW.archive_policy_id,NEW.archive_policy_version,NEW.archive_policy_snapshot,'documents.archive',NEW.created_at)
  AND app_guest_identity_delegated_policy(NEW.organization_id,original.reservation_id,NEW.retention_policy_id,NEW.retention_policy_version,NEW.retention_policy_snapshot,'documents.retention',NEW.created_at)
  AND NEW.archive_policy_snapshot->'value'->>'source'='NATIVE_DOCUMENT_ARCHIVE' AND NEW.archive_policy_snapshot->'value'->>'encryption'='APP_MANAGED_AEAD'
  AND NEW.archive_policy_snapshot->'value'->>'downloads'='AUTHORIZED_SERVER_PROXY' AND NEW.archive_policy_snapshot->'value'->>'history'='APPEND_ONLY'
  AND NEW.retention_policy_snapshot->'value'->>'source'='NATIVE_DOCUMENT_VERSIONS' AND NEW.retention_policy_snapshot->'value'->>'artifact_inheritance'='ORIGINAL_SIGNED_VERSION'
  AND NEW.retention_policy_snapshot->'value'->>'archive_tagging'='ALLOW'
 ,false) THEN RAISE EXCEPTION 'guest_identity_delegation_requires_atomic_original_grant_and_actual_canonical_archive_retention';END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER guest_identity_delegation_native BEFORE INSERT ON guest_hub_identity_document_delegation FOR EACH ROW EXECUTE FUNCTION app_guard_guest_identity_delegation_native();

ALTER TABLE guest_hub_form_grant DROP CONSTRAINT guest_form_grant_shape;
ALTER TABLE guest_hub_form_grant ADD CONSTRAINT guest_form_grant_shape CHECK(coalesce(
 form_key IN('PROFILE','STAY_DETAILS','IDENTITY_DOCUMENTS') AND decision IN('GRANTED','WITHDRAWN') AND version>0 AND ((version=1)=(previous_id IS NULL))
 AND isfinite(created_at) AND isfinite(expires_at) AND created_at=date_trunc('milliseconds',created_at) AND expires_at=date_trunc('milliseconds',expires_at)
 AND command_hash ~ '^[a-f0-9]{64}$' AND review_fingerprint ~ '^[a-f0-9]{64}$' AND source_fingerprint ~ '^[a-f0-9]{64}$'
 AND link_token_hash ~ '^[a-f0-9]{64}$' AND signature ~ '^[a-f0-9]{64}$' AND length(signature_version) BETWEEN 1 AND 120
 AND length(btrim(reason)) BETWEEN 1 AND 1000 AND length(request_id) BETWEEN 1 AND 200
 AND jsonb_typeof(source_snapshot)='object' AND jsonb_typeof(policy_snapshot)='object'
 AND jsonb_typeof(authorization_cap)='object' AND authorization_cap->>'schemaVersion'='1'
 AND authorization_cap->>'organizationId'=organization_id::text AND authorization_cap->>'userAccountId'=created_by::text
 AND (decision='WITHDRAWN' AND policy_id IS NULL AND policy_version IS NULL AND policy_fingerprint IS NULL AND policy_snapshot='{}'::jsonb
  OR decision='GRANTED' AND expires_at>created_at AND policy_id IS NOT NULL AND policy_version>0 AND policy_fingerprint ~ '^[a-f0-9]{64}$'
   AND policy_snapshot->>'id'=policy_id::text AND policy_snapshot->>'version'=policy_version::text
   AND policy_snapshot-ARRAY['id','version','value']='{}'::jsonb AND jsonb_typeof(policy_snapshot->'value')='object')
 ,false));

CREATE OR REPLACE FUNCTION app_guest_form_actual_policy(org UUID,policy_id UUID,policy_version INTEGER,snapshot JSONB,res UUID,prop UUID,at_time TIMESTAMPTZ,form_key TEXT) RETURNS BOOLEAN LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE rule config_rule%ROWTYPE;r reservation%ROWTYPE;p property%ROWTYPE;
BEGIN
 SELECT * INTO rule FROM config_rule WHERE organization_id=org AND id=policy_id FOR SHARE;
 SELECT * INTO r FROM reservation WHERE organization_id=org AND id=res;
 SELECT * INTO p FROM property WHERE organization_id=org AND id=prop;
 RETURN coalesce(rule.id IS NOT NULL AND form_key IN('PROFILE','STAY_DETAILS','IDENTITY_DOCUMENTS') AND rule.key=CASE form_key WHEN 'PROFILE' THEN 'guest_hub.profile' WHEN 'STAY_DETAILS' THEN 'guest_hub.stay_details' WHEN 'IDENTITY_DOCUMENTS' THEN 'guest_hub.identity_documents' END AND rule.created_by IS NOT NULL AND rule.lifecycle='ACTIVE'
  AND rule.version=policy_version AND snapshot=jsonb_build_object('id',rule.id::text,'version',rule.version,'value',rule.value)
  AND rule.effective_from<=at_time AND (rule.effective_to IS NULL OR rule.effective_to>at_time)
  AND rule.value->>'source'=CASE form_key WHEN 'PROFILE' THEN 'NATIVE_RESERVATION_GUEST_PROFILE' WHEN 'STAY_DETAILS' THEN 'NATIVE_RESERVATION_GUEST_STAY_DETAILS' WHEN 'IDENTITY_DOCUMENTS' THEN 'NATIVE_GUEST_IDENTITY_DOCUMENTS' END AND rule.value->>'history'=CASE form_key WHEN 'PROFILE' THEN 'APPEND_ONLY_RESERVATION_PROFILE' WHEN 'STAY_DETAILS' THEN 'APPEND_ONLY_RESERVATION_STAY_DETAILS' WHEN 'IDENTITY_DOCUMENTS' THEN 'APPEND_ONLY_RESERVATION_IDENTITY_CAPTURES' END
  AND rule.value->>'enabled'='true' AND length(btrim(rule.value->>'processing_approval_reference')) BETWEEN 1 AND 1000
  AND jsonb_typeof(rule.value->'notice')='object'
  AND (form_key IN('PROFILE','STAY_DETAILS') AND jsonb_typeof(rule.value->'allowed_fields')='array'
   OR form_key='IDENTITY_DOCUMENTS' AND jsonb_typeof(rule.value->'document_types')='array' AND jsonb_array_length(rule.value->'document_types')>0
    AND rule.value->>'storage'='EXISTING_ENCRYPTED_DOCUMENT_ARCHIVE' AND length(btrim(rule.value->>'retention_approval_reference')) BETWEEN 1 AND 1000)
  AND (rule.scope_type='organization' AND rule.scope_id IS NULL OR rule.scope_type='property' AND rule.scope_id=p.id OR rule.scope_type='city' AND rule.scope_id=p.city_id
   OR rule.scope_type='agreement' AND EXISTS(SELECT 1 FROM management_agreement a WHERE a.organization_id=org AND a.id=rule.scope_id AND a.property_id=p.id AND a.archived_at IS NULL AND a.status<>'DRAFT' AND a.effective_from<=at_time AND (a.effective_to IS NULL OR a.effective_to>at_time))
   OR rule.scope_type='booking_source_property' AND EXISTS(SELECT 1 FROM booking_channel c WHERE c.organization_id=org AND c.id=rule.scope_id AND c.property_id=p.id AND c.source_key=r.source AND c.archived_at IS NULL)),false);
END $$;
CREATE OR REPLACE FUNCTION app_guard_guest_form_grant_birth() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM outbox_event e WHERE e.organization_id=NEW.organization_id AND e.id=NEW.outbox_event_id AND e.type='guest_hub.form_grant_recorded'
  AND e.payload=jsonb_build_object('grantId',NEW.id::text,'linkId',NEW.link_id::text,'reservationId',NEW.reservation_id::text,'formKey',NEW.form_key,'decision',NEW.decision)
  AND e.idempotency_key='guest-hub-form-grant:'||NEW.created_by::text||':'||NEW.command_key::text AND e.occurred_at=NEW.created_at AND e.status='PENDING' AND e.attempt_count=0 AND e.xmin::text=pg_current_xact_id()::xid::text)
  OR NOT EXISTS(SELECT 1 FROM audit_log a WHERE a.organization_id=NEW.organization_id AND a.actor_id=NEW.created_by AND a.action='guest_hub.form_grant_recorded' AND a.resource_type=CASE NEW.form_key WHEN 'PROFILE' THEN 'guest_hub_profile' WHEN 'STAY_DETAILS' THEN 'guest_hub_stay_details' WHEN 'IDENTITY_DOCUMENTS' THEN 'guest_hub_identity_documents' END
   AND a.resource_id=NEW.id AND a.property_scope_id=NEW.property_id AND a.request_id=NEW.request_id AND a.reason=NEW.reason AND a.occurred_at=NEW.created_at
   AND a.after=jsonb_build_object('grantId',NEW.id::text,'linkId',NEW.link_id::text,'reservationId',NEW.reservation_id::text,'formKey',NEW.form_key,'decision',NEW.decision,'commandHash',NEW.command_hash,'outboxEventId',NEW.outbox_event_id::text)
   AND a.xmin::text=pg_current_xact_id()::xid::text)
 THEN RAISE EXCEPTION 'guest_form_grant_requires_exact_atomic_metadata_event_and_audit';END IF;
 IF NEW.form_key='IDENTITY_DOCUMENTS' AND NEW.decision='GRANTED' AND NOT EXISTS(
  SELECT 1 FROM guest_hub_identity_document_delegation d WHERE d.organization_id=NEW.organization_id AND d.grant_id=NEW.id AND d.created_at=NEW.created_at AND d.xmin::text=pg_current_xact_id()::xid::text)
 THEN RAISE EXCEPTION 'guest_identity_grant_requires_atomic_original_document_authority_delegation';END IF;
 RETURN NULL;
END $$;
COMMIT;
