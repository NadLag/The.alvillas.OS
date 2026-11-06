BEGIN;
-- Retain every original document, instance, financial row and audit. Only native relation/index and additive guards change.
DROP INDEX document_instance_document_unique;
CREATE INDEX document_instance_history_idx ON document_instance(organization_id,document_id,created_at,id);
ALTER TABLE document_action DROP CONSTRAINT document_action_shape;
ALTER TABLE document_action ADD CONSTRAINT document_action_shape CHECK (
  action IN ('CREATED','ADMITTED','VERSION_ADDED','ARCHIVED','RESTORED','TEMPLATE_CREATED','INSTANCE_CREATED','SIGNATURE_CREATED','CLASSIFICATION_STRENGTHENED')
  AND length(reason) BETWEEN 8 AND 1000 AND command_hash ~ '^[a-f0-9]{64}$' AND source_fingerprint ~ '^[a-f0-9]{64}$'
  AND jsonb_typeof(before)='object' AND jsonb_typeof(after)='object');

CREATE OR REPLACE FUNCTION app_guard_native_document_generation() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE original jsonb; identity jsonb; command jsonb; root document%ROWTYPE; selected document_version%ROWTYPE;
  definition document%ROWTYPE; original_template document_template%ROWTYPE; rule config_rule%ROWTYPE;
  variant jsonb; cipher bytea; variant_count integer; type_policy jsonb; amendment boolean; previous document_version%ROWTYPE; prior_instance document_instance%ROWTYPE; prior_template_key text;
BEGIN
  original=NEW.source_snapshot;
  IF original->>'protocol' IS DISTINCT FROM 'ALVILLAS_GENERATED_DOCUMENT_V1' THEN
    IF EXISTS(SELECT 1 FROM document_instance i WHERE i.organization_id=NEW.organization_id AND i.document_id=NEW.document_id AND i.id<>NEW.id) THEN RAISE EXCEPTION 'document amendments require their actual immutable generation intent'; END IF;
    RETURN NULL; END IF;
  identity=original->'identity'; command=original->'command';
  SELECT * INTO root FROM document WHERE organization_id=NEW.organization_id AND id=NEW.document_id;
  SELECT * INTO selected FROM document_version WHERE organization_id=NEW.organization_id AND id=NEW.template_version_id;
  SELECT * INTO definition FROM document WHERE organization_id=NEW.organization_id AND id=selected.document_id;
  SELECT * INTO original_template FROM document_template WHERE organization_id=NEW.organization_id AND document_id=definition.id;
  SELECT * INTO rule FROM config_rule WHERE organization_id=NEW.organization_id AND id=(original->'policySnapshot'->>'id')::uuid;
  SELECT value INTO type_policy FROM jsonb_array_elements(rule.value->'types') WHERE value->>'key'=root.type_key;
  amendment=command->>'documentId' IS NOT NULL;
  IF amendment THEN
    SELECT * INTO previous FROM document_version WHERE organization_id=NEW.organization_id AND document_id=root.id ORDER BY number DESC LIMIT 1;
    SELECT i.* INTO prior_instance FROM document_instance i JOIN document_admission a ON a.organization_id=i.organization_id AND a.input->>'generationInstanceId'=i.id::text
      WHERE i.organization_id=NEW.organization_id AND i.document_id=root.id AND a.id=previous.admission_id;
    SELECT t.key INTO prior_template_key FROM document_version v JOIN document_template t ON t.organization_id=v.organization_id AND t.document_id=v.document_id WHERE v.organization_id=NEW.organization_id AND v.id=prior_instance.template_version_id;
  END IF;
  IF NOT coalesce(original->>'schemaVersion'='1' AND jsonb_typeof(identity)='object' AND jsonb_typeof(command)='object'
    AND identity->>'organizationId'=NEW.organization_id::text AND identity->>'documentId'=root.id::text AND identity->>'instanceId'=NEW.id::text
    AND identity->>'templateVersionId'=selected.id::text AND identity->>'templateSha256'=(SELECT sha256 FROM document_admission WHERE organization_id=NEW.organization_id AND id=selected.admission_id)
    AND identity->>'sourceFingerprint'=NEW.source_fingerprint AND identity->>'sha256' ~ '^[a-f0-9]{64}$'
    AND (identity->>'byteSize')::integer BETWEEN 1 AND 1064960
    AND original->>'commandHash'=NEW.command_hash AND original->>'nativeSourceFingerprint' ~ '^[a-f0-9]{64}$'
    AND original->>'contractFingerprint' ~ '^[a-f0-9]{64}$' AND jsonb_typeof(original->'sourceKeys')='array' AND jsonb_array_length(original->'sourceKeys')<=200
    AND original->'authorizationCap'->>'organizationId'=NEW.organization_id::text AND original->'authorizationCap'->>'userAccountId'=NEW.created_by::text
    AND command->>'idempotencyKey'=NEW.command_key::text AND command->>'templateVersionId'=selected.id::text
    AND command->'source'->>'kind'=root.source_kind AND command->'source'->>'id'=root.source_id::text
    AND (amendment OR command->>'title'=root.title) AND root.kind='INSTANCE' AND (amendment OR (root.created_by=NEW.created_by AND root.created_at=NEW.created_at))
    AND (amendment OR (root.command_key=NEW.command_key AND root.command_hash=NEW.command_hash)) AND root.revision::text=coalesce(original->>'documentRevision','1')
    AND selected.id IS NOT NULL AND definition.kind='TEMPLATE' AND definition.type_key=root.type_key AND definition.locale=root.locale
    AND jsonb_typeof(original->'variants')='array' AND jsonb_array_length(original->'variants') BETWEEN 2 AND 3
    AND jsonb_typeof(command->'variantVersionIds')='array'
    AND rule.id IS NOT NULL AND rule.key='documents.archive' AND rule.value=original->'policySnapshot'->'value'
    AND rule.version::text=original->'policySnapshot'->>'version' AND (amendment OR root.policy_snapshot=original->'policySnapshot')
    AND type_policy->'sources' ? root.source_kind AND type_policy->'content_types' ? 'application/pdf'
    AND root.privacy@>ARRAY(SELECT jsonb_array_elements_text(type_policy->'privacy'))
    AND jsonb_typeof(rule.value->'upload_transport')='object' AND jsonb_typeof(original->'payloadCipher')='string',false)
  THEN RAISE EXCEPTION 'native document generation requires original instance, source, template, policy and captured actor'; END IF;
  IF amendment THEN
    IF NOT coalesce(command->>'documentId'=root.id::text AND command->>'supersedesId'=previous.id::text AND previous.id IS NOT NULL
      AND prior_instance.id IS NOT NULL AND prior_instance.source_snapshot->>'protocol'='ALVILLAS_GENERATED_DOCUMENT_V1'
      AND prior_template_key=original_template.key AND root.created_at<=NEW.created_at AND root.archived_at IS NULL,false)
    THEN RAISE EXCEPTION 'generated amendment requires the actual latest version and original logical document, source and template family'; END IF;
  ELSIF command->>'supersedesId' IS NOT NULL OR EXISTS(SELECT 1 FROM document_instance i WHERE i.organization_id=NEW.organization_id AND i.document_id=NEW.document_id AND i.id<>NEW.id) THEN
    RAISE EXCEPTION 'a second generation intent requires its immutable amendment predecessor';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM document_action a WHERE a.organization_id=NEW.organization_id AND a.document_id=root.id AND a.action='INSTANCE_CREATED'
    AND a.actor_id=NEW.created_by AND a.command_key=NEW.command_key AND a.command_hash=NEW.command_hash AND a.occurred_at=NEW.created_at
    AND a.after->>'instanceId'=NEW.id::text AND a.after->>'templateVersionId'=NEW.template_version_id::text
    AND (NOT amendment OR a.after->>'supersedesId'=previous.id::text) AND a.xmin::text=pg_current_xact_id()::xid::text)
  THEN RAISE EXCEPTION 'native generation requires its exact atomic instance lineage history'; END IF;
  cipher=decode(original->>'payloadCipher','base64');
  IF octet_length(cipher)<=(identity->>'byteSize')::integer OR octet_length(cipher)>(identity->>'byteSize')::integer+256
    OR (SELECT count(DISTINCT value) FROM jsonb_array_elements(original->'sourceKeys'))<>jsonb_array_length(original->'sourceKeys')
    OR EXISTS(SELECT 1 FROM jsonb_array_elements_text(original->'sourceKeys') field WHERE field !~ '^[a-z][a-z0-9_]{0,119}$')
  THEN RAISE EXCEPTION 'native generation requires bounded encrypted original and unique native fields'; END IF;
  variant_count=jsonb_array_length(original->'variants');
  IF (SELECT count(DISTINCT value->>'locale') FROM jsonb_array_elements(original->'variants'))<>variant_count
    OR (SELECT count(DISTINCT value->>'versionId') FROM jsonb_array_elements(original->'variants'))<>variant_count
    OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(original->'variants') v WHERE v->>'locale'='en')
    OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(original->'variants') v WHERE v->>'locale'='fr')
    OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(original->'variants') v WHERE v->>'versionId'=selected.id::text AND v->>'sha256'=identity->>'templateSha256')
    OR (SELECT jsonb_agg(value->>'versionId' ORDER BY value->>'versionId') FROM jsonb_array_elements(original->'variants'))
      IS DISTINCT FROM (SELECT jsonb_agg(value ORDER BY value) FROM jsonb_array_elements_text(command->'variantVersionIds'))
  THEN RAISE EXCEPTION 'native generation requires the explicitly selected original language contract'; END IF;
  FOR variant IN SELECT value FROM jsonb_array_elements(original->'variants') LOOP
    IF NOT EXISTS(SELECT 1 FROM document_version v JOIN document_admission a ON a.organization_id=v.organization_id AND a.id=v.admission_id
      JOIN document d ON d.organization_id=v.organization_id AND d.id=v.document_id
      JOIN document_template t ON t.organization_id=d.organization_id AND t.document_id=d.id
      WHERE v.organization_id=NEW.organization_id AND v.id::text=variant->>'versionId' AND d.id::text=variant->>'documentId'
        AND d.kind='TEMPLATE' AND d.type_key=root.type_key AND t.key=original_template.key AND d.locale=variant->>'locale'
        AND a.content_type='application/vnd.alvillas.document-template+json' AND a.payload_cipher IS NOT NULL
        AND a.sha256=variant->>'sha256' AND variant->>'fingerprint' ~ '^[a-f0-9]{64}$' AND d.archived_at IS NULL)
    THEN RAISE EXCEPTION 'native generation language variant must be its actual retained template original'; END IF;
  END LOOP;
  IF NOT EXISTS(SELECT 1 FROM outbox_event e WHERE e.organization_id=NEW.organization_id AND e.type='documents.instance.requested'
    AND e.payload=jsonb_build_object('instanceId',NEW.id::text) AND e.idempotency_key='document-generation:'||NEW.created_by::text||':'||NEW.command_key::text
    AND e.occurred_at=NEW.created_at AND e.xmin::text=pg_current_xact_id()::xid::text)
  THEN RAISE EXCEPTION 'native generation requires its atomic reference-only outbox'; END IF;
  RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION app_guard_generated_document_payload() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE instance document_instance%ROWTYPE; original jsonb;
BEGIN
  SELECT * INTO instance FROM document_instance WHERE organization_id=NEW.organization_id AND document_id=NEW.document_id AND id::text=NEW.input->>'generationInstanceId';
  original=instance.source_snapshot;
  IF NOT (NEW.payload_cipher IS NOT NULL AND NEW.content_type='application/pdf') AND NOT (NEW.input ? 'generationInstanceId')
    AND NOT EXISTS(SELECT 1 FROM document_instance i WHERE i.organization_id=NEW.organization_id AND i.document_id=NEW.document_id AND i.source_snapshot->>'protocol'='ALVILLAS_GENERATED_DOCUMENT_V1') THEN RETURN NEW; END IF;
  IF instance.id IS NULL OR NOT coalesce(original->>'protocol'='ALVILLAS_GENERATED_DOCUMENT_V1'
    AND NEW.input->>'generationInstanceId'=instance.id::text AND NEW.input->>'kind'='INSTANCE' AND NEW.input->'templateKey'='null'::jsonb
    AND NEW.input->'supersedesId'=coalesce(original->'command'->'supersedesId','null'::jsonb) AND NEW.input->>'title'=original->'command'->>'title'
    AND NEW.input->'effectiveFrom'=original->'command'->'effectiveFrom' AND NEW.input->>'reason'=original->'command'->>'reason'
    AND NEW.input->>'reviewFingerprint'=original->'command'->>'reviewFingerprint'
    AND NEW.content_type='application/pdf' AND NEW.payload_cipher IS NOT NULL AND NEW.supersedes_id IS NOT DISTINCT FROM (original->'command'->>'supersedesId')::uuid
    AND NEW.expected_revision::text=coalesce(original->>'documentRevision','1')
    AND NEW.created_by=instance.created_by AND NEW.command_key=instance.command_key AND NEW.command_hash=instance.command_hash
    AND NEW.authorization_cap=original->'authorizationCap' AND NEW.policy_snapshot=original->'policySnapshot'
    AND NEW.source_fingerprint=original->>'nativeSourceFingerprint',false)
  THEN RAISE EXCEPTION 'generated PDF payload requires its exact original native generation and actor'; END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION app_document_version_matches_instance(organization_uuid uuid,version_uuid uuid,instance_uuid uuid) RETURNS boolean LANGUAGE SQL STABLE SET search_path=public,pg_temp AS $$
  SELECT EXISTS(SELECT 1 FROM document_version v JOIN document_admission a ON a.organization_id=v.organization_id AND a.id=v.admission_id
    JOIN document_instance i ON i.organization_id=v.organization_id AND i.document_id=v.document_id AND i.id=instance_uuid
    WHERE v.organization_id=organization_uuid AND v.id=version_uuid AND a.content_type='application/pdf'
      AND (a.input->>'generationInstanceId'=i.id::text OR (NOT (a.input ? 'generationInstanceId') AND i.source_snapshot->>'protocol' IS DISTINCT FROM 'ALVILLAS_GENERATED_DOCUMENT_V1'
        AND NOT EXISTS(SELECT 1 FROM document_instance other WHERE other.organization_id=i.organization_id AND other.document_id=i.document_id AND other.id<>i.id))));
$$;

CREATE OR REPLACE FUNCTION app_guard_document_related_source() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE root document%ROWTYPE; source_root document%ROWTYPE; version document_version%ROWTYPE; instance document_instance%ROWTYPE;
BEGIN
  IF TG_TABLE_NAME='document_template' THEN
    SELECT * INTO root FROM document WHERE organization_id=NEW.organization_id AND id=NEW.document_id;
    IF root.kind<>'TEMPLATE' OR root.locale<>NEW.locale OR root.created_by<>NEW.created_by THEN RAISE EXCEPTION 'native document template identity required'; END IF;
    PERFORM app_document_action_required(NEW.organization_id,NEW.document_id,'TEMPLATE_CREATED',NEW.created_by,NEW.created_at);
  ELSIF TG_TABLE_NAME='document_instance' THEN
    SELECT * INTO root FROM document WHERE organization_id=NEW.organization_id AND id=NEW.document_id;
    SELECT * INTO version FROM document_version WHERE organization_id=NEW.organization_id AND id=NEW.template_version_id;
    SELECT * INTO source_root FROM document WHERE organization_id=NEW.organization_id AND id=version.document_id;
    IF root.kind<>'INSTANCE' OR source_root.kind<>'TEMPLATE' OR source_root.locale<>root.locale OR (root.created_by<>NEW.created_by AND NOT coalesce(NEW.source_snapshot->>'protocol'='ALVILLAS_GENERATED_DOCUMENT_V1' AND NEW.source_snapshot->'command'->>'documentId'=root.id::text,false))
      OR source_root.type_key<>root.type_key OR version.id IS NULL OR root.id=source_root.id
    THEN RAISE EXCEPTION 'document instance requires its exact immutable template version'; END IF;
    PERFORM app_document_action_required(NEW.organization_id,NEW.document_id,'INSTANCE_CREATED',NEW.created_by,NEW.created_at);
  ELSIF TG_TABLE_NAME='signature' THEN
    SELECT * INTO instance FROM document_instance WHERE organization_id=NEW.organization_id AND id=NEW.instance_id;
    SELECT * INTO version FROM document_version WHERE organization_id=NEW.organization_id AND id=NEW.document_version_id;
    IF instance.document_id IS DISTINCT FROM version.document_id OR version.id IS NULL OR NOT app_document_version_matches_instance(NEW.organization_id,version.id,instance.id)
      OR NOT EXISTS(SELECT 1 FROM signature_event WHERE organization_id=NEW.organization_id AND signature_id=NEW.id AND state='DRAFT')
      OR NOT EXISTS(SELECT 1 FROM signature_recipient WHERE organization_id=NEW.organization_id AND signature_id=NEW.id)
    THEN RAISE EXCEPTION 'signature requires original instance, archived version, recipients and draft event'; END IF;
    PERFORM app_document_action_required(NEW.organization_id,version.document_id,'SIGNATURE_CREATED',NEW.requested_by,NEW.requested_at);
  END IF;
  RETURN NULL;
END $$;

CREATE FUNCTION app_guard_document_signature_version() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE original signature%ROWTYPE;
BEGIN
  SELECT * INTO original FROM signature WHERE organization_id=NEW.organization_id AND id=NEW.signature_id;
  IF original.id IS NULL OR (NEW.signed_version_id IS NOT NULL AND NOT app_document_version_matches_instance(NEW.organization_id,NEW.signed_version_id,original.instance_id))
  THEN RAISE EXCEPTION 'signature evidence cannot switch its original immutable generation instance'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER document_signature_version_guard BEFORE INSERT ON signature_event FOR EACH ROW EXECUTE FUNCTION app_guard_document_signature_version();

COMMIT;
