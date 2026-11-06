BEGIN;

-- Additive native generation protection; no existing document or financial rows are rewritten.
ALTER TABLE document_admission DROP CONSTRAINT document_template_payload_shape;
ALTER TABLE document_admission ADD CONSTRAINT document_template_payload_shape CHECK (coalesce((
  (content_type='application/vnd.alvillas.document-template+json' AND payload_cipher IS NOT NULL
    AND file_size<=1048576 AND octet_length(payload_cipher)>file_size AND octet_length(payload_cipher)<=file_size+256
    AND NOT (input ? 'parts') AND coalesce(jsonb_typeof(policy_snapshot->'value'->'upload_transport')='object',false))
  OR (content_type='application/pdf' AND payload_cipher IS NOT NULL
    AND input->>'kind'='INSTANCE' AND coalesce(length(input->>'generationInstanceId')=36,false)
    AND octet_length(payload_cipher)>file_size AND octet_length(payload_cipher)<=file_size+256
    AND NOT (input ? 'parts') AND coalesce(jsonb_typeof(policy_snapshot->'value'->'upload_transport')='object',false))
  OR (content_type<>'application/vnd.alvillas.document-template+json' AND payload_cipher IS NULL AND NOT (input ? 'generationInstanceId'))),false));

CREATE FUNCTION app_guard_native_document_generation() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE original jsonb; identity jsonb; command jsonb; root document%ROWTYPE; selected document_version%ROWTYPE;
  definition document%ROWTYPE; original_template document_template%ROWTYPE; rule config_rule%ROWTYPE;
  variant jsonb; cipher bytea; variant_count integer; type_policy jsonb;
BEGIN
  original=NEW.source_snapshot;
  IF original->>'protocol' IS DISTINCT FROM 'ALVILLAS_GENERATED_DOCUMENT_V1' THEN RETURN NULL; END IF;
  identity=original->'identity'; command=original->'command';
  SELECT * INTO root FROM document WHERE organization_id=NEW.organization_id AND id=NEW.document_id;
  SELECT * INTO selected FROM document_version WHERE organization_id=NEW.organization_id AND id=NEW.template_version_id;
  SELECT * INTO definition FROM document WHERE organization_id=NEW.organization_id AND id=selected.document_id;
  SELECT * INTO original_template FROM document_template WHERE organization_id=NEW.organization_id AND document_id=definition.id;
  SELECT * INTO rule FROM config_rule WHERE organization_id=NEW.organization_id AND id=(original->'policySnapshot'->>'id')::uuid;
  SELECT value INTO type_policy FROM jsonb_array_elements(rule.value->'types') WHERE value->>'key'=root.type_key;
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
    AND command->>'title'=root.title AND root.kind='INSTANCE' AND root.created_by=NEW.created_by AND root.created_at=NEW.created_at
    AND root.command_key=NEW.command_key AND root.command_hash=NEW.command_hash AND root.revision=1
    AND selected.id IS NOT NULL AND definition.kind='TEMPLATE' AND definition.type_key=root.type_key AND definition.locale=root.locale
    AND jsonb_typeof(original->'variants')='array' AND jsonb_array_length(original->'variants') BETWEEN 2 AND 3
    AND jsonb_typeof(command->'variantVersionIds')='array'
    AND rule.id IS NOT NULL AND rule.key='documents.archive' AND rule.value=original->'policySnapshot'->'value'
    AND rule.version::text=original->'policySnapshot'->>'version' AND root.policy_snapshot=original->'policySnapshot'
    AND type_policy->'sources' ? root.source_kind AND type_policy->'content_types' ? 'application/pdf'
    AND root.privacy@>ARRAY(SELECT jsonb_array_elements_text(type_policy->'privacy'))
    AND jsonb_typeof(rule.value->'upload_transport')='object' AND jsonb_typeof(original->'payloadCipher')='string',false)
  THEN RAISE EXCEPTION 'native document generation requires original instance, source, template, policy and captured actor'; END IF;
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
CREATE CONSTRAINT TRIGGER native_document_generation_guard AFTER INSERT ON document_instance DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION app_guard_native_document_generation();

CREATE FUNCTION app_guard_generated_document_payload() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE instance document_instance%ROWTYPE; original jsonb;
BEGIN
  SELECT * INTO instance FROM document_instance WHERE organization_id=NEW.organization_id AND document_id=NEW.document_id;
  original=instance.source_snapshot;
  IF NOT (NEW.payload_cipher IS NOT NULL AND NEW.content_type='application/pdf') AND NOT (NEW.input ? 'generationInstanceId')
    AND original->>'protocol' IS DISTINCT FROM 'ALVILLAS_GENERATED_DOCUMENT_V1' THEN RETURN NEW; END IF;
  IF instance.id IS NULL OR NOT coalesce(original->>'protocol'='ALVILLAS_GENERATED_DOCUMENT_V1'
    AND NEW.input->>'generationInstanceId'=instance.id::text AND NEW.input->>'kind'='INSTANCE' AND NEW.input->'templateKey'='null'::jsonb
    AND NEW.input->'supersedesId'='null'::jsonb AND NEW.input->>'title'=original->'command'->>'title'
    AND NEW.input->'effectiveFrom'=original->'command'->'effectiveFrom' AND NEW.input->>'reason'=original->'command'->>'reason'
    AND NEW.input->>'reviewFingerprint'=original->'command'->>'reviewFingerprint'
    AND NEW.content_type='application/pdf' AND NEW.payload_cipher IS NOT NULL AND NEW.supersedes_id IS NULL
    AND NEW.created_by=instance.created_by AND NEW.command_key=instance.command_key AND NEW.command_hash=instance.command_hash
    AND NEW.authorization_cap=original->'authorizationCap' AND NEW.policy_snapshot=original->'policySnapshot'
    AND NEW.source_fingerprint=original->>'nativeSourceFingerprint',false)
  THEN RAISE EXCEPTION 'generated PDF payload requires its exact original native generation and actor'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER generated_document_payload_guard BEFORE INSERT ON document_admission FOR EACH ROW EXECUTE FUNCTION app_guard_generated_document_payload();

CREATE FUNCTION app_guard_document_generation_outbox() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    IF OLD.type='documents.instance.requested' OR OLD.idempotency_key LIKE 'document-generation:%' THEN RAISE EXCEPTION 'native generation references are append-only'; END IF;
    RETURN OLD;
  END IF;
  IF TG_OP='UPDATE' THEN
    IF (OLD.type='documents.instance.requested' OR NEW.type='documents.instance.requested' OR OLD.idempotency_key LIKE 'document-generation:%' OR NEW.idempotency_key LIKE 'document-generation:%')
      AND ROW(NEW.id,NEW.organization_id,NEW.type,NEW.payload,NEW.idempotency_key,NEW.occurred_at,NEW.created_at)
        IS DISTINCT FROM ROW(OLD.id,OLD.organization_id,OLD.type,OLD.payload,OLD.idempotency_key,OLD.occurred_at,OLD.created_at)
    THEN RAISE EXCEPTION 'native generation reference identity is immutable'; END IF;
    RETURN NEW;
  END IF;
  IF NEW.type<>'documents.instance.requested' AND NEW.idempotency_key NOT LIKE 'document-generation:%' THEN RETURN NEW; END IF;
  IF NOT EXISTS(SELECT 1 FROM document_instance i WHERE i.organization_id=NEW.organization_id AND i.source_snapshot->>'protocol'='ALVILLAS_GENERATED_DOCUMENT_V1'
    AND NEW.type='documents.instance.requested' AND NEW.payload=jsonb_build_object('instanceId',i.id::text)
    AND NEW.idempotency_key='document-generation:'||i.created_by::text||':'||i.command_key::text AND NEW.occurred_at=i.created_at
    AND i.xmin::text=pg_current_xact_id()::xid::text AND NEW.status='PENDING' AND NEW.attempt_count=0 AND NEW.processed_at IS NULL)
  THEN RAISE EXCEPTION 'native generation outbox requires its atomic tenant instance reference'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER document_generation_outbox_guard BEFORE INSERT OR UPDATE OR DELETE ON outbox_event FOR EACH ROW EXECUTE FUNCTION app_guard_document_generation_outbox();

COMMIT;
