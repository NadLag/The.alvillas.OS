BEGIN;
-- Native file identities point to the existing encrypted archive; no second file store is introduced.
CREATE TABLE guest_hub_identity_document_admission (
 organization_id UUID NOT NULL,
 file_id UUID NOT NULL,
 document_id UUID NOT NULL,
 admission_id UUID NOT NULL,
 retention_policy_id UUID NOT NULL,
 retention_policy_version INTEGER NOT NULL,
 retention_policy_snapshot JSONB NOT NULL,
 tag_keys TEXT[] NOT NULL,
 tags JSONB NOT NULL,
 outbox_event_id UUID NOT NULL,
 created_at TIMESTAMPTZ(6) NOT NULL,
 request_id TEXT NOT NULL,
 CONSTRAINT guest_identity_admission_pkey PRIMARY KEY(organization_id,file_id),
 CONSTRAINT guest_identity_admission_organization_fk FOREIGN KEY(organization_id) REFERENCES organization(id) ON DELETE RESTRICT ON UPDATE NO ACTION,
 CONSTRAINT guest_identity_admission_file_fk FOREIGN KEY(organization_id,file_id) REFERENCES guest_hub_identity_document_file(organization_id,id) ON DELETE RESTRICT ON UPDATE NO ACTION,
 CONSTRAINT guest_identity_admission_document_fk FOREIGN KEY(organization_id,document_id) REFERENCES document(organization_id,id) ON DELETE RESTRICT ON UPDATE NO ACTION,
 CONSTRAINT guest_identity_admission_original_fk FOREIGN KEY(organization_id,admission_id) REFERENCES document_admission(organization_id,id) ON DELETE RESTRICT ON UPDATE NO ACTION,
 CONSTRAINT guest_identity_admission_policy_fk FOREIGN KEY(organization_id,retention_policy_id) REFERENCES config_rule(organization_id,id) ON DELETE RESTRICT ON UPDATE NO ACTION,
 CONSTRAINT guest_identity_admission_outbox_fk FOREIGN KEY(organization_id,outbox_event_id) REFERENCES outbox_event(organization_id,id) ON DELETE RESTRICT ON UPDATE NO ACTION,
 CONSTRAINT guest_identity_admission_shape CHECK(coalesce(
  retention_policy_version>0 AND isfinite(created_at) AND created_at=date_trunc('milliseconds',created_at) AND length(request_id) BETWEEN 1 AND 200
  AND cardinality(tag_keys) BETWEEN 1 AND 64 AND array_position(tag_keys,NULL) IS NULL
  AND jsonb_typeof(tags)='array' AND jsonb_array_length(tags)=cardinality(tag_keys)
  AND retention_policy_snapshot-ARRAY['organizationId','id','version','value']='{}'::jsonb
  AND retention_policy_snapshot->>'organizationId'=organization_id::text AND retention_policy_snapshot->>'id'=retention_policy_id::text
  AND retention_policy_snapshot->>'version'=retention_policy_version::text AND jsonb_typeof(retention_policy_snapshot->'value')='object'
 ,false))
);
CREATE UNIQUE INDEX guest_identity_admission_document_key ON guest_hub_identity_document_admission(organization_id,document_id);
CREATE UNIQUE INDEX guest_identity_admission_original_key ON guest_hub_identity_document_admission(organization_id,admission_id);
CREATE UNIQUE INDEX guest_identity_admission_outbox_key ON guest_hub_identity_document_admission(organization_id,outbox_event_id);
CREATE INDEX guest_identity_admission_policy_idx ON guest_hub_identity_document_admission(organization_id,retention_policy_id);

CREATE TABLE guest_hub_identity_document_publication (
 organization_id UUID NOT NULL,
 file_id UUID NOT NULL,
 version_id UUID NOT NULL,
 retention_revision_id UUID NOT NULL,
 outbox_event_id UUID NOT NULL,
 created_at TIMESTAMPTZ(6) NOT NULL,
 request_id TEXT NOT NULL,
 CONSTRAINT guest_identity_publication_pkey PRIMARY KEY(organization_id,file_id),
 CONSTRAINT guest_identity_publication_organization_fk FOREIGN KEY(organization_id) REFERENCES organization(id) ON DELETE RESTRICT ON UPDATE NO ACTION,
 CONSTRAINT guest_identity_publication_original_fk FOREIGN KEY(organization_id,file_id) REFERENCES guest_hub_identity_document_admission(organization_id,file_id) ON DELETE RESTRICT ON UPDATE NO ACTION,
 CONSTRAINT guest_identity_publication_version_fk FOREIGN KEY(organization_id,version_id) REFERENCES document_version(organization_id,id) ON DELETE RESTRICT ON UPDATE NO ACTION,
 CONSTRAINT guest_identity_publication_retention_fk FOREIGN KEY(organization_id,retention_revision_id) REFERENCES document_retention_revision(organization_id,id) ON DELETE RESTRICT ON UPDATE NO ACTION,
 CONSTRAINT guest_identity_publication_outbox_fk FOREIGN KEY(organization_id,outbox_event_id) REFERENCES outbox_event(organization_id,id) ON DELETE RESTRICT ON UPDATE NO ACTION,
 CONSTRAINT guest_identity_publication_shape CHECK(isfinite(created_at) AND created_at=date_trunc('milliseconds',created_at) AND length(request_id) BETWEEN 1 AND 200)
);
CREATE UNIQUE INDEX guest_identity_publication_version_key ON guest_hub_identity_document_publication(organization_id,version_id);
CREATE UNIQUE INDEX guest_identity_publication_retention_key ON guest_hub_identity_document_publication(organization_id,retention_revision_id);
CREATE UNIQUE INDEX guest_identity_publication_outbox_key ON guest_hub_identity_document_publication(organization_id,outbox_event_id);

ALTER TABLE guest_hub_identity_document_admission ENABLE ROW LEVEL SECURITY;
ALTER TABLE guest_hub_identity_document_admission FORCE ROW LEVEL SECURITY;
CREATE POLICY guest_hub_identity_document_admission_tenant_isolation ON guest_hub_identity_document_admission
 USING(organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid)
 WITH CHECK(organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid);
ALTER TABLE guest_hub_identity_document_publication ENABLE ROW LEVEL SECURITY;
ALTER TABLE guest_hub_identity_document_publication FORCE ROW LEVEL SECURITY;
CREATE POLICY guest_hub_identity_document_publication_tenant_isolation ON guest_hub_identity_document_publication
 USING(organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid)
 WITH CHECK(organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid);
CREATE TRIGGER guest_identity_admission_immutable BEFORE UPDATE OR DELETE ON guest_hub_identity_document_admission FOR EACH ROW EXECUTE FUNCTION app_onboarding_append_only();
CREATE TRIGGER guest_identity_publication_immutable BEFORE UPDATE OR DELETE ON guest_hub_identity_document_publication FOR EACH ROW EXECUTE FUNCTION app_onboarding_append_only();

CREATE FUNCTION app_guest_identity_document_origin(org UUID,file UUID) RETURNS JSONB LANGUAGE SQL STABLE SET search_path=public,pg_temp AS $$
 SELECT jsonb_build_object('protocol','ALVILLAS_NATIVE_GUEST_IDENTITY_DOCUMENT_V1','origin','GUEST_CAPABILITY','organizationId',org::text,
  'linkId',c.link_id::text,'grantId',g.id::text,'captureId',c.id::text,'fileId',f.id::text,'delegatedBy',g.created_by::text)
 FROM guest_hub_identity_document_file f JOIN guest_hub_identity_document_capture c ON(c.organization_id,c.id)=(f.organization_id,f.capture_id)
 JOIN guest_hub_form_grant g ON(g.organization_id,g.id)=(c.organization_id,c.grant_id) WHERE f.organization_id=org AND f.id=file
$$;

CREATE FUNCTION app_guard_guest_identity_admission_native() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE original RECORD;root RECORD;file_row guest_hub_identity_document_file%ROWTYPE;capture_row guest_hub_identity_document_capture%ROWTYPE;grant_row guest_hub_form_grant%ROWTYPE;delegation guest_hub_identity_document_delegation%ROWTYPE;item JSONB;
BEGIN
 SELECT a.*,a.xmin::text AS native_xmin INTO original FROM document_admission a WHERE a.organization_id=NEW.organization_id AND a.id=NEW.admission_id FOR SHARE OF a;
 SELECT d.*,d.xmin::text AS native_xmin INTO root FROM document d WHERE d.organization_id=NEW.organization_id AND d.id=NEW.document_id FOR SHARE OF d;
 SELECT * INTO file_row FROM guest_hub_identity_document_file WHERE organization_id=NEW.organization_id AND id=NEW.file_id;
 SELECT * INTO capture_row FROM guest_hub_identity_document_capture WHERE organization_id=NEW.organization_id AND id=file_row.capture_id;
 SELECT * INTO grant_row FROM guest_hub_form_grant WHERE organization_id=NEW.organization_id AND id=capture_row.grant_id;
 SELECT * INTO delegation FROM guest_hub_identity_document_delegation WHERE organization_id=NEW.organization_id AND grant_id=grant_row.id;
 IF NOT coalesce(original.id IS NOT NULL AND root.id IS NOT NULL AND capture_row.id IS NOT NULL AND delegation.grant_id IS NOT NULL
  AND original.native_xmin=pg_current_xact_id()::xid::text AND root.native_xmin=pg_current_xact_id()::xid::text
  AND original.document_id=root.id AND original.command_key=NEW.file_id AND root.command_key=NEW.file_id
  AND original.created_at=NEW.created_at AND root.created_at=NEW.created_at AND NEW.created_at>=capture_row.created_at AND NEW.created_at<=clock_timestamp()
  AND root.source_kind='RESERVATION' AND root.source_id=capture_row.reservation_id AND root.reservation_id=capture_row.reservation_id AND root.kind='FILE' AND root.archived_at IS NULL
  AND 'sensitive'=ANY(root.privacy) AND NOT 'financial'=ANY(root.privacy)
  AND root.created_by=grant_row.created_by AND original.created_by=grant_row.created_by AND original.authorization_cap=grant_row.authorization_cap
  AND grant_row.form_key='IDENTITY_DOCUMENTS' AND grant_row.decision='GRANTED' AND NEW.created_at<grant_row.expires_at
  AND grant_row.id=(SELECT id FROM guest_hub_form_grant WHERE organization_id=NEW.organization_id AND link_id=capture_row.link_id AND form_key='IDENTITY_DOCUMENTS' ORDER BY version DESC LIMIT 1)
  AND capture_row.id=(SELECT id FROM guest_hub_identity_document_capture WHERE organization_id=NEW.organization_id AND reservation_id=capture_row.reservation_id AND guest_id=capture_row.guest_id ORDER BY version DESC LIMIT 1)
  AND NOT EXISTS(SELECT 1 FROM guest_hub_link_revocation WHERE organization_id=NEW.organization_id AND link_id=capture_row.link_id)
  AND app_guest_profile_actual_source(NEW.organization_id,capture_row.reservation_id,capture_row.property_id,capture_row.guest_id,capture_row.source_snapshot)
  AND original.expected_revision=1 AND original.supersedes_id IS NULL AND original.payload_cipher IS NULL
  AND original.input->'guestIdentity'=jsonb_build_object('protocol','ALVILLAS_NATIVE_GUEST_IDENTITY_DOCUMENT_V1','captureId',capture_row.id::text,'fileId',NEW.file_id::text)
  AND original.input->>'documentId'=root.id::text AND original.input->'source'=jsonb_build_object('kind','RESERVATION','id',capture_row.reservation_id::text)
  AND original.input->>'kind'='FILE' AND original.input->>'typeKey'=root.type_key AND original.input->>'locale'=root.locale AND original.input->>'title'=root.title
  AND original.input->>'idempotencyKey'=NEW.file_id::text AND original.input->'supersedesId'='null'::jsonb AND original.input->'effectiveFrom'='null'::jsonb AND original.input->'templateKey'='null'::jsonb
  AND original.content_type IN('application/pdf','image/png','image/jpeg')
  AND original.file_name='identity-'||NEW.file_id::text||CASE original.content_type WHEN 'application/pdf' THEN '.pdf' WHEN 'image/png' THEN '.png' WHEN 'image/jpeg' THEN '.jpg' END
  AND app_guest_identity_delegated_policy(NEW.organization_id,capture_row.reservation_id,(original.policy_snapshot->>'id')::uuid,(original.policy_snapshot->>'version')::integer,jsonb_build_object('organizationId',NEW.organization_id::text)||original.policy_snapshot,'documents.archive',NEW.created_at)
  AND app_guest_identity_delegated_policy(NEW.organization_id,capture_row.reservation_id,NEW.retention_policy_id,NEW.retention_policy_version,NEW.retention_policy_snapshot,'documents.retention',NEW.created_at)
  AND NEW.retention_policy_snapshot->'value'->>'archive_tagging'='ALLOW'
  AND (NEW.retention_policy_snapshot->'value'->'type_keys') ? root.type_key
 ,false) THEN RAISE EXCEPTION 'guest_identity_admission_requires_exact_atomic_original_file_and_canonical_archive';END IF;
 IF NEW.tag_keys<>ARRAY(SELECT DISTINCT value COLLATE "C" FROM unnest(NEW.tag_keys) value ORDER BY value COLLATE "C")
  OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(capture_row.policy_snapshot->'value'->'document_types') type
   WHERE type->>'kind'=file_row.kind AND type->>'document_type_key'=root.type_key AND (type->'allowed_parts') ? file_row.part
    AND ARRAY(SELECT value FROM jsonb_array_elements_text(type->'retention_tag_keys') value ORDER BY value COLLATE "C")=NEW.tag_keys)
  OR (SELECT count(DISTINCT value->>'key') FROM jsonb_array_elements(NEW.tags))<>cardinality(NEW.tag_keys)
 THEN RAISE EXCEPTION 'guest_identity_admission_requires_original_configured_retention_selection';END IF;
 FOR item IN SELECT value FROM jsonb_array_elements(NEW.tags) LOOP
  IF NOT coalesce(item->>'key'=ANY(NEW.tag_keys)
   AND EXISTS(SELECT 1 FROM jsonb_array_elements(delegation.retention_policy_snapshot->'value'->'tags') tag WHERE tag=item)
   AND EXISTS(SELECT 1 FROM jsonb_array_elements(NEW.retention_policy_snapshot->'value'->'tags') tag WHERE tag=item),false)
  THEN RAISE EXCEPTION 'guest_identity_admission_cannot_repurpose_original_retention_context';END IF;
 END LOOP;
 RETURN NEW;
END $$;
CREATE TRIGGER guest_identity_admission_native_guard BEFORE INSERT ON guest_hub_identity_document_admission FOR EACH ROW EXECUTE FUNCTION app_guard_guest_identity_admission_native();

CREATE FUNCTION app_guard_guest_identity_admission_birth() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE source RECORD;
BEGIN
 SELECT c.* INTO source FROM guest_hub_identity_document_file f JOIN guest_hub_identity_document_capture c ON(c.organization_id,c.id)=(f.organization_id,f.capture_id) WHERE f.organization_id=NEW.organization_id AND f.id=NEW.file_id;
 IF NOT EXISTS(SELECT 1 FROM outbox_event e WHERE e.organization_id=NEW.organization_id AND e.id=NEW.outbox_event_id AND e.type='guest_hub.identity_document_admitted'
  AND e.payload=jsonb_build_object('captureId',source.id::text,'fileId',NEW.file_id::text,'documentId',NEW.document_id::text,'admissionId',NEW.admission_id::text)
  AND e.idempotency_key='guest-hub-identity-document-admission:'||NEW.file_id::text AND e.occurred_at=NEW.created_at AND e.status='PENDING' AND e.attempt_count=0 AND e.xmin::text=pg_current_xact_id()::xid::text)
  OR NOT EXISTS(SELECT 1 FROM audit_log a WHERE a.organization_id=NEW.organization_id AND a.actor_id IS NULL AND a.action='guest_hub.identity_document_admitted' AND a.resource_type='guest_hub_identity_documents'
   AND a.resource_id=NEW.file_id AND a.property_scope_id=source.property_id AND a.request_id=NEW.request_id AND a.occurred_at=NEW.created_at
   AND a.after=jsonb_build_object('captureId',source.id::text,'fileId',NEW.file_id::text,'linkId',source.link_id::text,'grantId',source.grant_id::text,'documentId',NEW.document_id::text,'admissionId',NEW.admission_id::text,'outboxEventId',NEW.outbox_event_id::text)
   AND a.xmin::text=pg_current_xact_id()::xid::text)
  OR EXISTS(SELECT 1 FROM (VALUES('CREATED','documents.created'),('ADMITTED','documents.admitted')) expected(action,audit_action)
   WHERE NOT EXISTS(SELECT 1 FROM document_action h JOIN audit_log a ON(a.organization_id,a.resource_id)=(h.organization_id,h.id)
    JOIN document_admission d ON(d.organization_id,d.id)=(h.organization_id,NEW.admission_id)
    WHERE h.organization_id=NEW.organization_id AND h.document_id=NEW.document_id AND h.action=expected.action AND h.command_key=NEW.file_id AND h.command_hash=d.command_hash
     AND h.actor_id=d.created_by AND h.occurred_at=NEW.created_at AND h.xmin::text=pg_current_xact_id()::xid::text
     AND (expected.action<>'ADMITTED' OR h.after->>'admissionId'=NEW.admission_id::text)
     AND h.after->'guestIdentityOrigin'=app_guest_identity_document_origin(NEW.organization_id,NEW.file_id)
     AND a.actor_id IS NULL AND a.action=expected.audit_action AND a.resource_type='document' AND a.property_scope_id=source.property_id AND a.request_id=NEW.request_id AND a.occurred_at=NEW.created_at
     AND a.after->'guestIdentityOrigin'=app_guest_identity_document_origin(NEW.organization_id,NEW.file_id) AND a.xmin::text=pg_current_xact_id()::xid::text))
 THEN RAISE EXCEPTION 'guest_identity_admission_requires_atomic_original_metadata_event_and_audit';END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER guest_identity_admission_birth_guard AFTER INSERT ON guest_hub_identity_document_admission DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app_guard_guest_identity_admission_birth();

CREATE FUNCTION app_guard_guest_identity_canonical_admission_birth() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
 IF (NEW.input ? 'guestIdentity' OR EXISTS(SELECT 1 FROM guest_hub_identity_document_admission b WHERE b.organization_id=NEW.organization_id AND b.document_id=NEW.document_id))
  AND NOT EXISTS(SELECT 1 FROM guest_hub_identity_document_admission b WHERE b.organization_id=NEW.organization_id AND b.document_id=NEW.document_id AND b.admission_id=NEW.id AND b.xmin::text=pg_current_xact_id()::xid::text)
 THEN RAISE EXCEPTION 'native_identity_document_requires_its_exact_atomic_file_admission';END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER guest_identity_canonical_admission_birth_guard AFTER INSERT ON document_admission DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app_guard_guest_identity_canonical_admission_birth();

CREATE FUNCTION app_guard_guest_identity_publication_native() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE original guest_hub_identity_document_admission%ROWTYPE;version_row RECORD;retention_row RECORD;source RECORD;
BEGIN
 SELECT * INTO original FROM guest_hub_identity_document_admission WHERE organization_id=NEW.organization_id AND file_id=NEW.file_id;
 SELECT v.*,v.xmin::text AS native_xmin INTO version_row FROM document_version v WHERE v.organization_id=NEW.organization_id AND v.id=NEW.version_id FOR SHARE OF v;
 SELECT r.*,r.xmin::text AS native_xmin INTO retention_row FROM document_retention_revision r WHERE r.organization_id=NEW.organization_id AND r.id=NEW.retention_revision_id FOR SHARE OF r;
 SELECT c.*,g.decision AS grant_decision,g.expires_at AS grant_expires_at,g.created_by AS grant_creator INTO source
  FROM guest_hub_identity_document_file f JOIN guest_hub_identity_document_capture c ON(c.organization_id,c.id)=(f.organization_id,f.capture_id)
  JOIN guest_hub_form_grant g ON(g.organization_id,g.id)=(c.organization_id,c.grant_id) WHERE f.organization_id=NEW.organization_id AND f.id=NEW.file_id;
 IF NOT coalesce(original.file_id IS NOT NULL AND version_row.id IS NOT NULL AND retention_row.id IS NOT NULL
  AND version_row.native_xmin=pg_current_xact_id()::xid::text AND retention_row.native_xmin=pg_current_xact_id()::xid::text
  AND version_row.document_id=original.document_id AND version_row.admission_id=original.admission_id AND version_row.number=1 AND version_row.supersedes_id IS NULL AND version_row.effective_from IS NULL
  AND version_row.created_by=source.grant_creator AND retention_row.created_by=source.grant_creator AND retention_row.version_id=version_row.id AND retention_row.number=1 AND retention_row.previous_id IS NULL
  AND retention_row.tag_keys=original.tag_keys AND retention_row.tags=original.tags
  AND NEW.created_at=version_row.created_at AND NEW.created_at>=original.created_at AND NEW.created_at<=clock_timestamp()
  AND source.grant_decision='GRANTED' AND NEW.created_at<source.grant_expires_at
  AND source.grant_id=(SELECT id FROM guest_hub_form_grant WHERE organization_id=NEW.organization_id AND link_id=source.link_id AND form_key='IDENTITY_DOCUMENTS' ORDER BY version DESC LIMIT 1)
  AND source.id=(SELECT id FROM guest_hub_identity_document_capture WHERE organization_id=NEW.organization_id AND reservation_id=source.reservation_id AND guest_id=source.guest_id ORDER BY version DESC LIMIT 1)
  AND NOT EXISTS(SELECT 1 FROM guest_hub_link_revocation WHERE organization_id=NEW.organization_id AND link_id=source.link_id)
  AND app_guest_profile_actual_source(NEW.organization_id,source.reservation_id,source.property_id,source.guest_id,source.source_snapshot)
  AND app_guest_identity_delegated_policy(NEW.organization_id,source.reservation_id,(retention_row.policy_snapshot->>'id')::uuid,(retention_row.policy_snapshot->>'version')::integer,jsonb_build_object('organizationId',NEW.organization_id::text)||retention_row.policy_snapshot,'documents.retention',retention_row.created_at)
  AND retention_row.policy_snapshot->'value'->>'archive_tagging'='ALLOW'
 ,false) THEN RAISE EXCEPTION 'guest_identity_publication_requires_exact_atomic_original_version_and_retention';END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER guest_identity_publication_native_guard BEFORE INSERT ON guest_hub_identity_document_publication FOR EACH ROW EXECUTE FUNCTION app_guard_guest_identity_publication_native();

CREATE FUNCTION app_guard_guest_identity_publication_birth() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE original guest_hub_identity_document_admission%ROWTYPE;source RECORD;
BEGIN
 SELECT * INTO original FROM guest_hub_identity_document_admission WHERE organization_id=NEW.organization_id AND file_id=NEW.file_id;
 SELECT c.* INTO source FROM guest_hub_identity_document_file f JOIN guest_hub_identity_document_capture c ON(c.organization_id,c.id)=(f.organization_id,f.capture_id) WHERE f.organization_id=NEW.organization_id AND f.id=NEW.file_id;
 IF NOT EXISTS(SELECT 1 FROM outbox_event e WHERE e.organization_id=NEW.organization_id AND e.id=NEW.outbox_event_id AND e.type='guest_hub.identity_document_published'
  AND e.payload=jsonb_build_object('captureId',source.id::text,'fileId',NEW.file_id::text,'documentId',original.document_id::text,'admissionId',original.admission_id::text,'versionId',NEW.version_id::text,'retentionRevisionId',NEW.retention_revision_id::text)
  AND e.idempotency_key='guest-hub-identity-document-publication:'||NEW.file_id::text AND e.occurred_at=NEW.created_at AND e.status='PENDING' AND e.attempt_count=0 AND e.xmin::text=pg_current_xact_id()::xid::text)
  OR NOT EXISTS(SELECT 1 FROM audit_log a WHERE a.organization_id=NEW.organization_id AND a.actor_id IS NULL AND a.action='guest_hub.identity_document_published' AND a.resource_type='guest_hub_identity_documents'
   AND a.resource_id=NEW.file_id AND a.property_scope_id=source.property_id AND a.request_id=NEW.request_id AND a.occurred_at=NEW.created_at
   AND a.after=jsonb_build_object('captureId',source.id::text,'fileId',NEW.file_id::text,'linkId',source.link_id::text,'grantId',source.grant_id::text,'documentId',original.document_id::text,'admissionId',original.admission_id::text,'versionId',NEW.version_id::text,'retentionRevisionId',NEW.retention_revision_id::text,'outboxEventId',NEW.outbox_event_id::text)
   AND a.xmin::text=pg_current_xact_id()::xid::text)
  OR NOT EXISTS(SELECT 1 FROM document_action h JOIN audit_log a ON(a.organization_id,a.resource_id)=(h.organization_id,h.id)
   JOIN document_admission d ON(d.organization_id,d.id)=(h.organization_id,original.admission_id)
   WHERE h.organization_id=NEW.organization_id AND h.document_id=original.document_id AND h.action='VERSION_ADDED' AND h.command_key=NEW.file_id AND h.command_hash=d.command_hash
    AND h.actor_id=d.created_by AND h.occurred_at=NEW.created_at AND h.after->>'versionId'=NEW.version_id::text AND h.xmin::text=pg_current_xact_id()::xid::text
    AND h.after->'guestIdentityOrigin'=app_guest_identity_document_origin(NEW.organization_id,NEW.file_id)
    AND a.actor_id IS NULL AND a.action='documents.version_added' AND a.resource_type='document' AND a.property_scope_id=source.property_id AND a.request_id=NEW.request_id AND a.occurred_at=NEW.created_at
    AND a.after->'guestIdentityOrigin'=app_guest_identity_document_origin(NEW.organization_id,NEW.file_id) AND a.xmin::text=pg_current_xact_id()::xid::text)
  OR NOT EXISTS(SELECT 1 FROM audit_log a WHERE a.organization_id=NEW.organization_id AND a.actor_id IS NULL AND a.action='documents.retention_recorded' AND a.resource_type='document'
   AND a.resource_id=original.document_id AND a.property_scope_id=source.property_id AND a.request_id=NEW.request_id AND a.after->>'versionId'=NEW.version_id::text AND a.after->>'revisionId'=NEW.retention_revision_id::text
   AND a.after->'guestIdentityOrigin'=app_guest_identity_document_origin(NEW.organization_id,NEW.file_id) AND a.xmin::text=pg_current_xact_id()::xid::text)
 THEN RAISE EXCEPTION 'guest_identity_publication_requires_atomic_original_metadata_event_and_audit';END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER guest_identity_publication_birth_guard AFTER INSERT ON guest_hub_identity_document_publication DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app_guard_guest_identity_publication_birth();

CREATE FUNCTION app_guard_guest_identity_canonical_version_birth() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM guest_hub_identity_document_admission b WHERE b.organization_id=NEW.organization_id AND b.document_id=NEW.document_id)
  AND NOT EXISTS(SELECT 1 FROM guest_hub_identity_document_admission b JOIN guest_hub_identity_document_publication p ON(p.organization_id,p.file_id)=(b.organization_id,b.file_id)
   WHERE b.organization_id=NEW.organization_id AND b.document_id=NEW.document_id AND b.admission_id=NEW.admission_id AND p.version_id=NEW.id AND p.xmin::text=pg_current_xact_id()::xid::text)
 THEN RAISE EXCEPTION 'native_identity_version_requires_atomic_original_publication_and_retention';END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER guest_identity_canonical_version_birth_guard AFTER INSERT ON document_version DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app_guard_guest_identity_canonical_version_birth();

CREATE FUNCTION app_guard_guest_identity_archive_event_source() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
 IF TG_OP='DELETE' THEN
  IF OLD.type IN('guest_hub.identity_document_admitted','guest_hub.identity_document_published') THEN RAISE EXCEPTION 'guest_identity_archive_original_event_source_immutable';END IF;
  RETURN OLD;
 END IF;
 IF (OLD.type IN('guest_hub.identity_document_admitted','guest_hub.identity_document_published') OR NEW.type IN('guest_hub.identity_document_admitted','guest_hub.identity_document_published'))
  AND ROW(OLD.id,OLD.organization_id,OLD.type,OLD.payload,OLD.idempotency_key,OLD.occurred_at) IS DISTINCT FROM ROW(NEW.id,NEW.organization_id,NEW.type,NEW.payload,NEW.idempotency_key,NEW.occurred_at)
 THEN RAISE EXCEPTION 'guest_identity_archive_original_event_source_immutable';END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER guest_identity_archive_event_source_guard BEFORE UPDATE OR DELETE ON outbox_event FOR EACH ROW EXECUTE FUNCTION app_guard_guest_identity_archive_event_source();
CREATE FUNCTION app_guard_guest_identity_archive_event_birth() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
 IF NEW.type='guest_hub.identity_document_admitted' AND NOT EXISTS(SELECT 1 FROM guest_hub_identity_document_admission b WHERE b.organization_id=NEW.organization_id AND b.outbox_event_id=NEW.id AND b.xmin::text=pg_current_xact_id()::xid::text)
  OR NEW.type='guest_hub.identity_document_published' AND NOT EXISTS(SELECT 1 FROM guest_hub_identity_document_publication b WHERE b.organization_id=NEW.organization_id AND b.outbox_event_id=NEW.id AND b.xmin::text=pg_current_xact_id()::xid::text)
 THEN RAISE EXCEPTION 'guest_identity_archive_event_requires_its_actual_atomic_native_source';END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER guest_identity_archive_event_birth_guard AFTER INSERT ON outbox_event DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app_guard_guest_identity_archive_event_birth();
COMMIT;
