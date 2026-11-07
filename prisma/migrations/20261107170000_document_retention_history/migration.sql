-- Append descriptive retention history; no periods or legal disposal authority are inferred.
CREATE TABLE document_retention_revision (
  id UUID NOT NULL DEFAULT app_uuid_v7(),
  organization_id UUID NOT NULL,
  version_id UUID NOT NULL,
  previous_id UUID,
  number INTEGER NOT NULL,
  tag_keys TEXT[] NOT NULL,
  tags JSONB NOT NULL,
  command_key UUID NOT NULL,
  command_hash CHAR(64) NOT NULL,
  source_fingerprint CHAR(64) NOT NULL,
  authorization_cap JSONB NOT NULL,
  source_snapshot JSONB NOT NULL,
  policy_snapshot JSONB NOT NULL,
  input JSONB NOT NULL,
  reason TEXT NOT NULL,
  created_by UUID NOT NULL,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT document_retention_revision_pkey PRIMARY KEY(id)
);
CREATE UNIQUE INDEX document_retention_revision_org_id_unique ON document_retention_revision(organization_id,id);
CREATE UNIQUE INDEX document_retention_revision_number_unique ON document_retention_revision(organization_id,version_id,number);
CREATE UNIQUE INDEX document_retention_revision_successor_unique ON document_retention_revision(organization_id,previous_id);
CREATE UNIQUE INDEX document_retention_revision_command_unique ON document_retention_revision(organization_id,created_by,command_key);
CREATE INDEX document_retention_revision_nonce_owner_idx ON document_retention_revision(organization_id,command_key);
ALTER TABLE document_retention_revision ADD CONSTRAINT document_retention_revision_organization_id_fkey
  FOREIGN KEY(organization_id) REFERENCES organization(id) ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE document_retention_revision ADD CONSTRAINT document_retention_revision_organization_id_version_id_fkey
  FOREIGN KEY(organization_id,version_id) REFERENCES document_version(organization_id,id) ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE document_retention_revision ADD CONSTRAINT document_retention_revision_organization_id_previous_id_fkey
  FOREIGN KEY(organization_id,previous_id) REFERENCES document_retention_revision(organization_id,id) ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE document_retention_revision ADD CONSTRAINT document_retention_revision_organization_id_created_by_fkey
  FOREIGN KEY(organization_id,created_by) REFERENCES user_account(organization_id,id) ON DELETE RESTRICT ON UPDATE NO ACTION;

ALTER TABLE document_retention_revision ENABLE ROW LEVEL SECURITY;
ALTER TABLE document_retention_revision FORCE ROW LEVEL SECURITY;
CREATE POLICY document_retention_revision_tenant_isolation ON document_retention_revision
  USING(organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid)
  WITH CHECK(organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid);
CREATE TRIGGER document_retention_revision_immutable BEFORE UPDATE OR DELETE ON document_retention_revision
  FOR EACH ROW EXECUTE FUNCTION app_document_append_only();
ALTER TABLE document_retention_revision ADD CONSTRAINT document_retention_revision_shape CHECK(coalesce(
  number>0 AND ((number=1 AND previous_id IS NULL) OR (number>1 AND previous_id IS NOT NULL))
  AND cardinality(tag_keys) BETWEEN 0 AND 64 AND array_position(tag_keys,NULL) IS NULL
  AND jsonb_typeof(tags)='array' AND jsonb_array_length(tags)=cardinality(tag_keys) AND octet_length(tags::text)<=131072
  AND command_hash ~ '^[a-f0-9]{64}$' AND source_fingerprint ~ '^[a-f0-9]{64}$'
  AND length(reason) BETWEEN 8 AND 1000 AND created_at<=clock_timestamp()
  AND jsonb_typeof(authorization_cap)='object' AND jsonb_typeof(source_snapshot)='object'
  AND jsonb_typeof(policy_snapshot)='object' AND jsonb_typeof(input)='object',false));

CREATE FUNCTION app_guard_document_retention_revision() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE original document_version%ROWTYPE; root document%ROWTYPE; admission document_admission%ROWTYPE;
  prior document_retention_revision%ROWTYPE; rule config_rule%ROWTYPE; captured jsonb; canonical text[];
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.organization_id::text||':documents:retention:'||NEW.version_id::text,0));
  SELECT * INTO original FROM document_version WHERE organization_id=NEW.organization_id AND id=NEW.version_id;
  SELECT * INTO root FROM document WHERE organization_id=NEW.organization_id AND id=original.document_id;
  SELECT * INTO admission FROM document_admission WHERE organization_id=NEW.organization_id AND id=original.admission_id;
  SELECT * INTO prior FROM document_retention_revision WHERE organization_id=NEW.organization_id AND version_id=NEW.version_id AND id<>NEW.id ORDER BY number DESC LIMIT 1;
  SELECT * INTO rule FROM config_rule WHERE organization_id=NEW.organization_id AND id=(NEW.policy_snapshot->>'id')::uuid;
  SELECT coalesce(array_agg(key ORDER BY key COLLATE "C"),ARRAY[]::text[]) INTO canonical FROM(SELECT DISTINCT unnest(NEW.tag_keys) AS key) s;
  IF rule.id IS NOT NULL THEN SELECT coalesce(jsonb_agg(value ORDER BY value->>'key' COLLATE "C"),'[]'::jsonb) INTO captured
    FROM jsonb_array_elements(rule.value->'tags') WHERE value->>'key'=ANY(NEW.tag_keys); END IF;
  IF original.id IS NULL OR root.id IS NULL OR admission.id IS NULL OR root.kind NOT IN('FILE','TEMPLATE','INSTANCE')
    OR EXISTS(SELECT 1 FROM signature_signed_artifact WHERE organization_id=NEW.organization_id AND document_id=root.id)
    OR (prior.id IS NULL AND (NEW.previous_id IS NOT NULL OR NEW.number<>1))
    OR (prior.id IS NOT NULL AND (NEW.previous_id IS DISTINCT FROM prior.id OR NEW.number<>prior.number+1 OR NEW.created_at<prior.created_at))
    OR NEW.authorization_cap->>'organizationId' IS DISTINCT FROM NEW.organization_id::text
    OR NEW.authorization_cap->>'userAccountId' IS DISTINCT FROM NEW.created_by::text
    OR NEW.source_snapshot->>'documentId' IS DISTINCT FROM root.id::text
    OR NEW.source_snapshot->>'versionId' IS DISTINCT FROM original.id::text
    OR NEW.source_snapshot->>'versionSha256' IS DISTINCT FROM admission.sha256
    OR NOT coalesce(NEW.source_snapshot->'privacy' @> to_jsonb(root.privacy),false)
    OR NOT coalesce(NEW.source_snapshot->>'archiveFingerprint' ~ '^[a-f0-9]{64}$',false)
    OR NEW.input->>'protocol' IS DISTINCT FROM 'ALVILLAS_DOCUMENT_RETENTION_V1'
    OR NEW.input->>'versionId' IS DISTINCT FROM NEW.version_id::text
    OR NEW.input->>'previousRevisionId' IS DISTINCT FROM NEW.previous_id::text
    OR NEW.input->'tagKeys' IS DISTINCT FROM to_jsonb(NEW.tag_keys)
    OR NEW.input->>'idempotencyKey' IS DISTINCT FROM NEW.command_key::text OR NEW.input->>'reason' IS DISTINCT FROM NEW.reason
    OR NOT coalesce(NEW.input->>'reviewFingerprint' ~ '^[a-f0-9]{64}$',false)
    OR NEW.tag_keys IS DISTINCT FROM canonical OR NEW.tags IS DISTINCT FROM captured
    OR jsonb_array_length(NEW.tags)<>cardinality(NEW.tag_keys)
    OR rule.id IS NULL OR rule.key<>'documents.retention' OR rule.scope_type<>'organization' OR rule.scope_id IS NOT NULL
    OR NEW.policy_snapshot IS DISTINCT FROM jsonb_build_object('id',rule.id,'version',rule.version,'value',rule.value)
    OR rule.value->>'source' IS DISTINCT FROM 'NATIVE_DOCUMENT_VERSIONS'
    OR rule.value->>'artifact_inheritance' IS DISTINCT FROM 'ORIGINAL_SIGNED_VERSION'
    OR NOT coalesce(rule.value->>'archive_tagging' IN('ALLOW','DENY'),false)
    OR (root.archived_at IS NOT NULL AND rule.value->>'archive_tagging'<>'ALLOW')
    OR NOT coalesce(rule.value->'type_keys' ? root.type_key,false)
  THEN RAISE EXCEPTION 'document retention requires its actual version, previous immutable revision and configured tag snapshots'; END IF;
  IF NOT EXISTS(SELECT 1 FROM audit_log l WHERE l.organization_id=NEW.organization_id AND l.resource_type='document' AND l.resource_id=root.id
    AND l.action='documents.retention_recorded' AND l.actor_id=NEW.created_by AND l.occurred_at=NEW.created_at AND l.reason=NEW.reason
    AND l.after->>'revisionId'=NEW.id::text AND l.after->>'documentId'=root.id::text AND l.after->>'versionId'=NEW.version_id::text
    AND l.after->>'previousRevisionId' IS NOT DISTINCT FROM NEW.previous_id::text
    AND l.after->'tagKeys'=to_jsonb(NEW.tag_keys) AND l.after->>'number'=NEW.number::text
    AND l.after->>'commandHash'=NEW.command_hash AND l.after->>'sourceFingerprint'=NEW.source_fingerprint
    AND l.xmin::text=pg_current_xact_id()::xid::text AND NEW.xmin::text=l.xmin::text)
  THEN RAISE EXCEPTION 'document retention requires its atomic private actor audit'; END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER document_retention_revision_guard AFTER INSERT ON document_retention_revision
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app_guard_document_retention_revision();

-- Preserve the existing generation/admission nonce pairing and every signature/expiry fence.
CREATE OR REPLACE FUNCTION app_guard_document_signature_nonce() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE actor_uuid uuid;
BEGIN
  IF TG_TABLE_NAME='document_action' THEN IF NEW.action<>'SIGNED_ARCHIVE_RECONCILED' THEN RETURN NEW; END IF; actor_uuid:=NEW.actor_id;
  ELSIF TG_TABLE_NAME IN('signature','signature_provider_intent','signature_provider_identity_recovery') THEN actor_uuid:=NEW.requested_by; ELSE actor_uuid:=NEW.created_by; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.organization_id::text||':documents:nonce:'||actor_uuid::text||':'||NEW.command_key::text,0));
  IF TG_TABLE_NAME IN('signature','signature_provider_intent','signature_provider_identity_recovery','document_action','document_expiry_revision','document_retention_revision') AND (
    EXISTS(SELECT 1 FROM document_admission WHERE organization_id=NEW.organization_id AND created_by=actor_uuid AND command_key=NEW.command_key)
    OR EXISTS(SELECT 1 FROM document_instance WHERE organization_id=NEW.organization_id AND created_by=actor_uuid AND command_key=NEW.command_key))
    OR TG_TABLE_NAME<>'signature' AND EXISTS(SELECT 1 FROM signature WHERE organization_id=NEW.organization_id AND requested_by=actor_uuid AND command_key=NEW.command_key)
    OR TG_TABLE_NAME<>'signature_provider_intent' AND EXISTS(SELECT 1 FROM signature_provider_intent WHERE organization_id=NEW.organization_id AND requested_by=actor_uuid AND command_key=NEW.command_key)
    OR TG_TABLE_NAME<>'signature_provider_identity_recovery' AND EXISTS(SELECT 1 FROM signature_provider_identity_recovery WHERE organization_id=NEW.organization_id AND requested_by=actor_uuid AND command_key=NEW.command_key)
    OR TG_TABLE_NAME<>'document_action' AND EXISTS(SELECT 1 FROM document_action WHERE organization_id=NEW.organization_id AND actor_id=actor_uuid AND command_key=NEW.command_key AND action='SIGNED_ARCHIVE_RECONCILED')
    OR TG_TABLE_NAME<>'document_expiry_revision' AND EXISTS(SELECT 1 FROM document_expiry_revision WHERE organization_id=NEW.organization_id AND created_by=actor_uuid AND command_key=NEW.command_key)
    OR TG_TABLE_NAME<>'document_retention_revision' AND EXISTS(SELECT 1 FROM document_retention_revision WHERE organization_id=NEW.organization_id AND created_by=actor_uuid AND command_key=NEW.command_key)
  THEN RAISE EXCEPTION 'document command nonce belongs to another protocol'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER document_retention_revision_nonce_guard BEFORE INSERT ON document_retention_revision
  FOR EACH ROW EXECUTE FUNCTION app_guard_document_signature_nonce();
