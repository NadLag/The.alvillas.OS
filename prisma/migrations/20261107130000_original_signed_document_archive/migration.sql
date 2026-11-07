BEGIN;

-- AlterTable
ALTER TABLE "document_action" ALTER COLUMN "actor_id" DROP NOT NULL;

-- AlterTable
ALTER TABLE "signature_provider_evidence" ADD COLUMN     "signed_archive_id" UUID;

-- CreateTable
CREATE TABLE "signature_signed_archive" (
    "id" UUID NOT NULL DEFAULT app_uuid_v7(),
    "organization_id" UUID NOT NULL,
    "signature_id" UUID NOT NULL,
    "preparation_attempt_id" UUID NOT NULL,
    "completion_evidence_id" UUID NOT NULL,
    "provider_scope_hash" CHAR(64) NOT NULL,
    "provider_request_id" TEXT NOT NULL,
    "command_hash" CHAR(64) NOT NULL,
    "canonical_request" TEXT NOT NULL,
    "source_snapshot" JSONB NOT NULL,
    "admitted_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "signature_signed_archive_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "signature_signed_artifact" (
    "id" UUID NOT NULL DEFAULT app_uuid_v7(),
    "organization_id" UUID NOT NULL,
    "archive_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "document_id" UUID NOT NULL,
    "admission_id" UUID NOT NULL,
    "source_snapshot" JSONB NOT NULL,
    "payload_cipher" BYTEA NOT NULL,
    "captured_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "signature_signed_artifact_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "signature_signed_archive_history_idx" ON "signature_signed_archive"("organization_id", "admitted_at", "id");

-- CreateIndex
CREATE UNIQUE INDEX "signature_signed_archive_org_id_unique" ON "signature_signed_archive"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "signature_signed_archive_original_unique" ON "signature_signed_archive"("organization_id", "signature_id");

-- CreateIndex
CREATE UNIQUE INDEX "signature_signed_artifact_org_id_unique" ON "signature_signed_artifact"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "signature_signed_artifact_kind_unique" ON "signature_signed_artifact"("organization_id", "archive_id", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "signature_signed_artifact_document_unique" ON "signature_signed_artifact"("organization_id", "document_id");

-- CreateIndex
CREATE UNIQUE INDEX "signature_signed_artifact_admission_unique" ON "signature_signed_artifact"("organization_id", "admission_id");

-- CreateIndex
CREATE UNIQUE INDEX "signature_provider_evidence_signed_archive_unique" ON "signature_provider_evidence"("organization_id", "signed_archive_id", "kind");

-- AddForeignKey
ALTER TABLE "signature_provider_evidence" ADD CONSTRAINT "signature_provider_evidence_organization_id_signed_archive_fkey" FOREIGN KEY ("organization_id", "signed_archive_id") REFERENCES "signature_signed_archive"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "signature_signed_archive" ADD CONSTRAINT "signature_signed_archive_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "signature_signed_archive" ADD CONSTRAINT "signature_signed_archive_organization_id_signature_id_fkey" FOREIGN KEY ("organization_id", "signature_id") REFERENCES "signature"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "signature_signed_archive" ADD CONSTRAINT "signature_signed_archive_organization_id_preparation_attem_fkey" FOREIGN KEY ("organization_id", "preparation_attempt_id") REFERENCES "signature_provider_attempt"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "signature_signed_archive" ADD CONSTRAINT "signature_signed_archive_organization_id_completion_eviden_fkey" FOREIGN KEY ("organization_id", "completion_evidence_id") REFERENCES "signature_provider_evidence"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "signature_signed_archive" ADD CONSTRAINT "signature_signed_archive_organization_id_provider_scope_ha_fkey" FOREIGN KEY ("organization_id", "provider_scope_hash") REFERENCES "signature_provider_scope"("organization_id", "scope_hash") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "signature_signed_artifact" ADD CONSTRAINT "signature_signed_artifact_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "signature_signed_artifact" ADD CONSTRAINT "signature_signed_artifact_organization_id_archive_id_fkey" FOREIGN KEY ("organization_id", "archive_id") REFERENCES "signature_signed_archive"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "signature_signed_artifact" ADD CONSTRAINT "signature_signed_artifact_organization_id_document_id_fkey" FOREIGN KEY ("organization_id", "document_id") REFERENCES "document"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "signature_signed_artifact" ADD CONSTRAINT "signature_signed_artifact_organization_id_admission_id_fkey" FOREIGN KEY ("organization_id", "admission_id") REFERENCES "document_admission"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;


ALTER TABLE signature_provider_evidence DROP CONSTRAINT signature_provider_evidence_shape;
ALTER TABLE signature_provider_evidence ADD CONSTRAINT signature_provider_evidence_shape CHECK(coalesce(
 (signed_archive_id IS NULL AND (
  phase IN('PREPARE','SEND') AND provider_scope_hash ~ '^[a-f0-9]{64}$'
  AND original_pdf_sha256 ~ '^[a-f0-9]{64}$' AND contract_hash ~ '^[a-f0-9]{64}$' AND observation_hash ~ '^[a-f0-9]{64}$' AND payload_sha256 ~ '^[a-f0-9]{64}$'
  AND payload_byte_size BETWEEN 1 AND 4194304 AND octet_length(payload_cipher)>payload_byte_size AND octet_length(payload_cipher)<=payload_byte_size+256
  AND (provider_request_id IS NULL OR provider_request_id ~ '^[A-Za-z0-9_-]{1,255}$')
  AND ((webhook_id IS NULL AND ((kind='PREPARED' AND phase='PREPARE' AND provider_request_id IS NOT NULL AND provider_state='DRAFT')
    OR (kind='SENT' AND phase='SEND' AND provider_request_id IS NOT NULL AND provider_state IN('PENDING','COMPLETED')) OR(kind='UNCERTAIN' AND provider_state IS NULL)))
   OR (webhook_id IS NOT NULL AND phase='PREPARE' AND provider_request_id IS NOT NULL
    AND ((kind='SENT' AND provider_state IN('PENDING','COMPLETED')) OR(kind='VIEWED' AND provider_state IN('PENDING','COMPLETED','REJECTED','CANCELLED'))
     OR(kind='DECLINED' AND provider_state IN('PENDING','REJECTED')) OR(kind='EXPIRED' AND provider_state='PENDING') OR(kind='COMPLETION' AND provider_state='COMPLETED')
     OR(kind='OBSERVED' AND provider_state IN('DRAFT','PENDING','COMPLETED','REJECTED','CANCELLED')) OR(kind='UNCERTAIN' AND provider_state IS NULL)))))) OR
 (signed_archive_id IS NOT NULL AND kind IN('ARCHIVE_CAPTURED','SIGNED') AND phase='PREPARE' AND webhook_id IS NULL AND identity_recovery_id IS NULL AND provider_request_id ~ '^[A-Za-z0-9_-]{1,255}$' AND provider_state='COMPLETED'
  AND provider_scope_hash ~ '^[a-f0-9]{64}$' AND original_pdf_sha256 ~ '^[a-f0-9]{64}$' AND contract_hash ~ '^[a-f0-9]{64}$' AND observation_hash ~ '^[a-f0-9]{64}$' AND payload_sha256 ~ '^[a-f0-9]{64}$'
  AND payload_byte_size BETWEEN 1 AND 4194304 AND octet_length(payload_cipher)>payload_byte_size AND octet_length(payload_cipher)<=payload_byte_size+256),false));

-- Forward-only native signed artifacts. Existing financial and business rows are untouched.
DO $$ DECLARE name text; BEGIN
  FOREACH name IN ARRAY ARRAY['signature_signed_archive','signature_signed_artifact'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',name);
    EXECUTE format('CREATE POLICY %I ON %I USING(organization_id=NULLIF(current_setting(''app.current_organization_id'',true),'''')::uuid) WITH CHECK(organization_id=NULLIF(current_setting(''app.current_organization_id'',true),'''')::uuid)',name||'_tenant_isolation',name);
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION app_document_append_only()',name||'_immutable',name);
  END LOOP;
END $$;
ALTER TABLE signature_signed_archive ADD CONSTRAINT signature_signed_archive_shape CHECK(coalesce(
  command_hash ~ '^[a-f0-9]{64}$' AND provider_scope_hash ~ '^[a-f0-9]{64}$' AND provider_request_id ~ '^[A-Za-z0-9_-]{1,255}$'
  AND octet_length(canonical_request) BETWEEN 1 AND 1064960 AND jsonb_typeof(source_snapshot)='object',false));
ALTER TABLE signature_signed_artifact ADD CONSTRAINT signature_signed_artifact_shape CHECK(coalesce(
  kind IN('SIGNED_ORIGINAL','CERTIFICATE') AND jsonb_typeof(source_snapshot)='object'
  AND octet_length(payload_cipher) BETWEEN 2 AND 10486016,false));
CREATE UNIQUE INDEX document_action_system_command_unique ON document_action(organization_id,document_id,command_key,action) WHERE actor_id IS NULL;
ALTER TABLE document_action DROP CONSTRAINT document_action_shape;
ALTER TABLE document_action ADD CONSTRAINT document_action_shape CHECK(coalesce(
  action IN('CREATED','ADMITTED','VERSION_ADDED','ARCHIVED','RESTORED','TEMPLATE_CREATED','INSTANCE_CREATED','SIGNATURE_CREATED','SIGNED_ARCHIVE_RECONCILED')
  AND length(reason) BETWEEN 8 AND 1000 AND command_hash ~ '^[a-f0-9]{64}$' AND source_fingerprint ~ '^[a-f0-9]{64}$'
  AND jsonb_typeof(before)='object' AND jsonb_typeof(after)='object'
  AND (actor_id IS NOT NULL OR action IN('CREATED','ADMITTED','VERSION_ADDED')),false));

CREATE FUNCTION app_signed_archive_action_valid(a document_action) RETURNS boolean LANGUAGE sql STABLE SET search_path=public,pg_temp AS $$
  SELECT coalesce(a.actor_id IS NULL AND a.action IN('CREATED','ADMITTED','VERSION_ADDED') AND a.before='{}'::jsonb AND EXISTS(
    SELECT 1 FROM signature_signed_artifact asset JOIN signature_signed_archive archive ON archive.organization_id=asset.organization_id AND archive.id=asset.archive_id
    JOIN document_admission admission ON admission.organization_id=asset.organization_id AND admission.id=asset.admission_id
    JOIN document root ON root.organization_id=asset.organization_id AND root.id=asset.document_id
    LEFT JOIN document_version version ON version.organization_id=asset.organization_id AND version.admission_id=asset.admission_id
    WHERE asset.organization_id=a.organization_id AND asset.document_id=a.document_id AND a.command_key=asset.id AND a.command_hash=admission.command_hash AND a.reason=admission.reason
      AND a.source_fingerprint=admission.source_fingerprint AND root.created_by::text=archive.source_snapshot->>'initiatedBy' AND admission.created_by=root.created_by
      AND ((a.action='CREATED' AND a.occurred_at=root.created_at) OR(a.action='ADMITTED' AND a.occurred_at=admission.created_at) OR(a.action='VERSION_ADDED' AND a.occurred_at=version.created_at))
      AND a.after=jsonb_build_object('documentId',root.id,'signatureId',archive.signature_id,'signedArchiveId',archive.id,'signedArtifactId',asset.id)
        ||CASE WHEN a.action='ADMITTED' THEN jsonb_build_object('admissionId',admission.id) ELSE '{}'::jsonb END
        ||CASE WHEN a.action='VERSION_ADDED' THEN jsonb_build_object('versionId',version.id) ELSE '{}'::jsonb END
      AND EXISTS(SELECT 1 FROM signature_provider_evidence e WHERE e.organization_id=asset.organization_id AND e.signed_archive_id=archive.id AND e.kind='ARCHIVE_CAPTURED')
  ),false);
$$;

CREATE OR REPLACE FUNCTION app_document_action_required(organization_uuid uuid,document_uuid uuid,action_key text,actor_uuid uuid,at_time timestamptz,version_uuid uuid DEFAULT NULL)
RETURNS void LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM document_action a JOIN audit_log l ON l.organization_id=a.organization_id AND l.resource_id=a.id
    AND l.resource_type='document' AND l.action='documents.'||lower(action_key)
    WHERE a.organization_id=organization_uuid AND a.document_id=document_uuid AND a.action=action_key AND a.occurred_at=at_time
    AND (a.actor_id=actor_uuid OR a.actor_id IS NULL AND app_signed_archive_action_valid(a) AND EXISTS(SELECT 1 FROM document root WHERE root.organization_id=organization_uuid AND root.id=document_uuid AND root.created_by=actor_uuid))
    AND (version_uuid IS NULL OR a.after->>(CASE WHEN action_key='ADMITTED' THEN 'admissionId' ELSE 'versionId' END)=version_uuid::text)
    AND l.actor_id IS NOT DISTINCT FROM a.actor_id AND l.occurred_at=a.occurred_at AND l.after->>'documentId'=a.document_id::text
    AND l.after->>'commandHash'=a.command_hash AND a.xmin::text=pg_current_xact_id()::xid::text AND l.xmin::text=a.xmin::text)
  THEN RAISE EXCEPTION 'document mutation requires atomic private history and canonical audit'; END IF;
END $$;

CREATE OR REPLACE FUNCTION app_guard_document_action() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
  IF NEW.actor_id IS NULL AND NOT app_signed_archive_action_valid(NEW) THEN RAISE EXCEPTION 'system document action requires its actual retained signed artifact'; END IF;
  IF NOT EXISTS(SELECT 1 FROM audit_log l WHERE l.organization_id=NEW.organization_id AND l.resource_id=NEW.id AND l.resource_type='document'
    AND l.action='documents.'||lower(NEW.action) AND l.actor_id IS NOT DISTINCT FROM NEW.actor_id AND l.occurred_at=NEW.occurred_at
    AND l.after->>'documentId'=NEW.document_id::text AND l.after->>'commandHash'=NEW.command_hash
    AND l.xmin::text=pg_current_xact_id()::xid::text)
  THEN RAISE EXCEPTION 'each private document action requires its own atomic canonical audit'; END IF; RETURN NULL;
END $$;

CREATE FUNCTION app_guard_signed_archive_admission() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE completion signature_provider_evidence%ROWTYPE; attempt signature_provider_attempt%ROWTYPE; intent signature_provider_intent%ROWTYPE; native signature%ROWTYPE; snapshot jsonb;
BEGIN
  SELECT * INTO completion FROM signature_provider_evidence WHERE organization_id=NEW.organization_id AND id=NEW.completion_evidence_id;
  SELECT * INTO attempt FROM signature_provider_attempt WHERE organization_id=NEW.organization_id AND id=NEW.preparation_attempt_id;
  SELECT * INTO intent FROM signature_provider_intent WHERE organization_id=NEW.organization_id AND id=attempt.intent_id;
  SELECT * INTO native FROM signature WHERE organization_id=NEW.organization_id AND id=NEW.signature_id;
  snapshot:=NEW.source_snapshot;
  IF NOT coalesce(native.id IS NOT NULL AND native.policy_snapshot->>'protocol'='ALVILLAS_NATIVE_SIGNATURE_REQUEST_V1' AND completion.kind='COMPLETION' AND completion.phase='PREPARE'
    AND completion.provider_state='COMPLETED' AND completion.webhook_id IS NOT NULL AND completion.signed_archive_id IS NULL
    AND completion.signature_id=native.id AND completion.attempt_id=attempt.id AND completion.provider_scope_hash=NEW.provider_scope_hash AND completion.provider_request_id=NEW.provider_request_id
    AND intent.id IS NOT NULL AND intent.signature_id=native.id AND intent.phase='PREPARE' AND attempt.signature_id=native.id AND intent.provider_scope_hash=NEW.provider_scope_hash AND NEW.admitted_at>=completion.observed_at
    AND snapshot->>'protocol'='ALVILLAS_SIGNED_SIGNATURE_ARCHIVE_V1' AND snapshot->>'schemaVersion'='1' AND snapshot->>'signatureId'=native.id::text AND snapshot->>'signatureCommandHash'=native.command_hash
    AND snapshot->>'contractHash'=completion.contract_hash AND snapshot->>'contractHash'=intent.policy_snapshot->>'contractHash'
    AND snapshot->'preparation'=jsonb_build_object('intentId',intent.id,'attemptId',attempt.id,'commandHash',intent.command_hash)
    AND snapshot->'completion'=jsonb_build_object('evidenceId',completion.id,'payloadSha256',completion.payload_sha256)
    AND snapshot->>'providerScopeHash'=NEW.provider_scope_hash AND snapshot->>'providerRequestId'=NEW.provider_request_id
    AND snapshot->'document'=native.policy_snapshot->'document' AND snapshot->'archivePolicy'=native.policy_snapshot->'archivePolicy' AND snapshot->'providerPolicy'=intent.policy_snapshot->'providerPolicy'
    AND snapshot->>'initiatedBy'=native.requested_by::text AND snapshot->'originalAuthorizationCap'=native.authorization_cap AND snapshot->>'originalSourceFingerprint'=native.source_fingerprint
    AND NEW.canonical_request::jsonb=snapshot AND encode(digest(NEW.canonical_request,'sha256'),'hex')=NEW.command_hash
    AND EXISTS(SELECT 1 FROM document_version v JOIN document root ON root.organization_id=v.organization_id AND root.id=v.document_id WHERE v.organization_id=NEW.organization_id AND v.id=native.document_version_id
      AND snapshot->>'title'=v.title AND snapshot->>'typeKey'=root.type_key AND jsonb_typeof(snapshot->'privacy')='array' AND snapshot->'privacy' ? 'sensitive' AND snapshot->'privacy' @>to_jsonb(root.privacy))
    AND EXISTS(SELECT 1 FROM audit_log l WHERE l.organization_id=NEW.organization_id AND l.actor_id IS NULL AND l.action='documents.signature.signed_archive_requested' AND l.resource_type='signature' AND l.resource_id=NEW.id AND l.occurred_at=NEW.admitted_at
      AND l.after=jsonb_build_object('signatureId',NEW.signature_id,'signedArchiveId',NEW.id,'completionEvidenceId',completion.id,'commandHash',NEW.command_hash) AND l.xmin::text=pg_current_xact_id()::xid::text)
    AND EXISTS(SELECT 1 FROM outbox_event e WHERE e.organization_id=NEW.organization_id AND e.type='documents.signature.signed_archive_requested' AND e.payload=jsonb_build_object('archiveId',NEW.id) AND e.idempotency_key='document-signed-archive:'||NEW.id::text AND e.occurred_at=NEW.admitted_at AND e.xmin::text=pg_current_xact_id()::xid::text),false)
  THEN RAISE EXCEPTION 'signed archive requires its exact original completed signature, audit and reference'; END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER signed_archive_admission_guard AFTER INSERT ON signature_signed_archive DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app_guard_signed_archive_admission();

CREATE FUNCTION app_guard_signed_archive_artifact() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE archive signature_signed_archive%ROWTYPE; root document%ROWTYPE; admission document_admission%ROWTYPE; snapshot jsonb; identity jsonb; boundary integer;
BEGIN
  SELECT * INTO archive FROM signature_signed_archive WHERE organization_id=NEW.organization_id AND id=NEW.archive_id;
  SELECT * INTO root FROM document WHERE organization_id=NEW.organization_id AND id=NEW.document_id;
  SELECT * INTO admission FROM document_admission WHERE organization_id=NEW.organization_id AND id=NEW.admission_id;
  snapshot:=NEW.source_snapshot; identity:=snapshot->'identity'; boundary:=position(decode('0a','hex') in NEW.payload_cipher);
  IF NOT coalesce(archive.id IS NOT NULL AND root.kind='FILE' AND root.id=admission.document_id AND root.revision=1 AND root.archived_at IS NULL
    AND root.created_by::text=archive.source_snapshot->>'initiatedBy' AND admission.created_by=root.created_by AND root.created_at=NEW.captured_at AND admission.created_at=NEW.captured_at
    AND NEW.captured_at>=archive.admitted_at AND root.command_key=NEW.id AND admission.command_key=NEW.id AND root.command_hash=admission.command_hash
    AND root.title=archive.source_snapshot->>'title' AND root.type_key=archive.source_snapshot->>'typeKey' AND root.locale=archive.source_snapshot->'document'->>'locale'
    AND to_jsonb(root.privacy)=archive.source_snapshot->'privacy' AND root.source_kind=archive.source_snapshot->'document'->'source'->>'kind' AND root.source_id::text=archive.source_snapshot->'document'->'source'->>'id'
    AND root.source_snapshot=jsonb_build_object('protocol','ALVILLAS_SIGNED_SIGNATURE_ARCHIVE_V1','signedArchiveId',archive.id,'signedArtifactId',NEW.id,'signatureId',archive.signature_id,'originalVersionId',archive.source_snapshot->'document'->>'versionId')
    AND root.policy_snapshot=archive.source_snapshot->'archivePolicy' AND admission.policy_snapshot=root.policy_snapshot AND admission.authorization_cap=archive.source_snapshot->'originalAuthorizationCap'
    AND admission.content_type='application/pdf' AND admission.payload_cipher IS NULL AND admission.supersedes_id IS NULL AND admission.expected_revision=1
    AND admission.input->>'signedArchiveId'=archive.id::text AND admission.input->>'signedArtifactId'=NEW.id::text AND admission.input->>'signedArtifactKind'=NEW.kind
    AND admission.input->>'documentId'=root.id::text AND admission.input->'supersedesId'='null'::jsonb AND admission.input->'effectiveFrom'='null'::jsonb AND admission.input->'templateKey'='null'::jsonb AND NOT admission.input ? 'parts'
    AND snapshot->>'protocol'='ALVILLAS_SIGNED_SIGNATURE_ARCHIVE_V1' AND snapshot->>'schemaVersion'='1' AND snapshot->>'archiveId'=archive.id::text AND snapshot->>'signatureId'=archive.signature_id::text
    AND snapshot->>'assetId'=NEW.id::text AND snapshot->>'kind'=NEW.kind AND snapshot->>'completionEvidenceId'=archive.completion_evidence_id::text AND snapshot->>'providerRequestId'=archive.provider_request_id AND snapshot->>'contractHash'=archive.source_snapshot->>'contractHash'
    AND identity=jsonb_build_object('organizationId',NEW.organization_id,'documentId',root.id,'admissionId',admission.id,'contentType','application/pdf','fileSize',admission.file_size,'sha256',admission.sha256)
    AND (snapshot->>'canonicalRequest')::jsonb=jsonb_build_object('organizationId',NEW.organization_id,'actorId',NULL,'input',admission.input) AND encode(digest(snapshot->>'canonicalRequest','sha256'),'hex')=admission.command_hash AND snapshot->>'commandHash'=admission.command_hash
    AND (snapshot->>'sourceCanonical')::jsonb=jsonb_build_object('archiveHash',archive.command_hash,'kind',NEW.kind,'identity',identity) AND encode(digest(snapshot->>'sourceCanonical','sha256'),'hex')=admission.source_fingerprint AND snapshot->>'sourceFingerprint'=admission.source_fingerprint
    AND boundary BETWEEN 1 AND 256 AND octet_length(NEW.payload_cipher)>admission.file_size AND octet_length(NEW.payload_cipher)<=admission.file_size+256
    AND convert_from(substring(NEW.payload_cipher FROM 1 FOR greatest(boundary-1,0)),'UTF8') ~ '^alvillas-binary-v1:[^:]{1,180}:[A-Za-z0-9_-]{16}:[A-Za-z0-9_-]{22}$'
    AND (SELECT count(*) FROM signature_signed_artifact asset WHERE asset.organization_id=NEW.organization_id AND asset.archive_id=archive.id)=2
    AND EXISTS(SELECT 1 FROM signature_signed_artifact peer JOIN document_admission original ON original.organization_id=peer.organization_id AND original.id=peer.admission_id WHERE peer.organization_id=NEW.organization_id AND peer.archive_id=archive.id AND peer.kind<>NEW.kind AND peer.captured_at=NEW.captured_at AND original.sha256<>admission.sha256)
    AND admission.sha256<>archive.source_snapshot->'document'->>'sha256'
    AND EXISTS(SELECT 1 FROM signature_provider_evidence e WHERE e.organization_id=NEW.organization_id AND e.signed_archive_id=archive.id AND e.kind='ARCHIVE_CAPTURED' AND e.observed_at>=NEW.captured_at AND e.xmin::text=pg_current_xact_id()::xid::text),false)
  THEN RAISE EXCEPTION 'signed artifact requires its exact encrypted original pair and capture proof'; END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER signed_archive_artifact_guard AFTER INSERT ON signature_signed_artifact DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app_guard_signed_archive_artifact();

CREATE FUNCTION app_guard_signed_document_marker() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
  IF TG_TABLE_NAME='document' THEN
    IF NEW.source_snapshot->>'protocol'='ALVILLAS_SIGNED_SIGNATURE_ARCHIVE_V1' AND NOT EXISTS(SELECT 1 FROM signature_signed_artifact a WHERE a.organization_id=NEW.organization_id AND a.document_id=NEW.id AND a.id::text=NEW.source_snapshot->>'signedArtifactId') THEN RAISE EXCEPTION 'signed root requires its native retained artifact'; END IF;
  ELSE
    IF NEW.input ? 'signedArchiveId' AND NOT EXISTS(SELECT 1 FROM signature_signed_artifact a WHERE a.organization_id=NEW.organization_id AND a.admission_id=NEW.id AND a.document_id=NEW.document_id AND a.id::text=NEW.input->>'signedArtifactId') THEN RAISE EXCEPTION 'signed admission requires its native retained artifact'; END IF;
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER signed_document_marker_guard AFTER INSERT ON document DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app_guard_signed_document_marker();
CREATE CONSTRAINT TRIGGER signed_admission_marker_guard AFTER INSERT ON document_admission DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app_guard_signed_document_marker();
CREATE FUNCTION app_guard_signed_document_immutable() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
  IF OLD.source_snapshot->>'protocol'='ALVILLAS_SIGNED_SIGNATURE_ARCHIVE_V1' OR EXISTS(SELECT 1 FROM signature_signed_artifact a WHERE a.organization_id=OLD.organization_id AND a.document_id=OLD.id)
  THEN RAISE EXCEPTION 'signed artifact root is immutable'; END IF; IF TG_OP='DELETE' THEN RETURN OLD; END IF; RETURN NEW;
END $$;
CREATE TRIGGER signed_document_immutable BEFORE UPDATE OR DELETE ON document FOR EACH ROW EXECUTE FUNCTION app_guard_signed_document_immutable();

CREATE FUNCTION app_native_signed_archive_event_valid(event signature_event) RETURNS boolean LANGUAGE sql STABLE SET search_path=public,pg_temp AS $$
  SELECT coalesce(event.state='SIGNED' AND EXISTS(
    SELECT 1 FROM signature_provider_evidence e JOIN signature_signed_archive archive ON archive.organization_id=e.organization_id AND archive.id=e.signed_archive_id
    JOIN signature_provider_evidence capture ON capture.organization_id=archive.organization_id AND capture.signed_archive_id=archive.id AND capture.kind='ARCHIVE_CAPTURED'
    JOIN signature_signed_artifact signed ON signed.organization_id=archive.organization_id AND signed.archive_id=archive.id AND signed.kind='SIGNED_ORIGINAL'
    JOIN signature_signed_artifact cert ON cert.organization_id=archive.organization_id AND cert.archive_id=archive.id AND cert.kind='CERTIFICATE'
    JOIN document_version signed_version ON signed_version.organization_id=signed.organization_id AND signed_version.admission_id=signed.admission_id
    JOIN document_version cert_version ON cert_version.organization_id=cert.organization_id AND cert_version.admission_id=cert.admission_id
    JOIN signature_provider_attempt attempt ON attempt.organization_id=e.organization_id AND attempt.id=e.attempt_id
    JOIN audit_log audit ON audit.organization_id=e.organization_id AND audit.resource_id=archive.signature_id AND audit.resource_type='signature' AND audit.action='documents.signature.signed' AND audit.actor_id IS NULL
    WHERE e.organization_id=event.organization_id AND e.id=event.provider_evidence_id AND e.kind='SIGNED' AND e.phase='PREPARE' AND e.webhook_id IS NULL AND e.identity_recovery_id IS NULL AND e.signature_id=event.signature_id AND e.signature_id=archive.signature_id
      AND e.attempt_id=archive.preparation_attempt_id AND e.provider_state='COMPLETED' AND e.provider_scope_hash=archive.provider_scope_hash AND e.provider_request_id=archive.provider_request_id
      AND event.provider_identity_hash=e.provider_scope_hash AND event.provider_request_id=e.provider_request_id AND event.provider_event_id='native-signed-archive:'||archive.id::text
      AND event.evidence_hash=e.payload_sha256 AND event.evidence_cipher=e.payload_cipher AND event.signed_version_id=signed_version.id AND event.observed_at=e.observed_at AND event.occurred_at<=event.observed_at
      AND capture.observed_at<=e.observed_at AND signed_version.created_at=cert_version.created_at AND signed_version.created_at<=e.observed_at
      AND audit.after=jsonb_build_object('signatureId',archive.signature_id,'intentId',attempt.intent_id,'attemptId',attempt.id,'evidenceId',e.id,'signatureEventId',event.id,'signedArchiveId',archive.id,'signedVersionId',signed_version.id,'certificateVersionId',cert_version.id)
      AND audit.occurred_at=e.observed_at AND audit.xmin::text=e.xmin::text
  ),false);
$$;
CREATE FUNCTION app_guard_signed_archive_evidence() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE archive signature_signed_archive%ROWTYPE; history signature_event%ROWTYPE; captured signature_provider_evidence%ROWTYPE;
BEGIN
  IF NEW.signed_archive_id IS NULL THEN RETURN NULL; END IF;
  SELECT * INTO archive FROM signature_signed_archive WHERE organization_id=NEW.organization_id AND id=NEW.signed_archive_id;
  IF NOT coalesce(NEW.kind IN('ARCHIVE_CAPTURED','SIGNED') AND NEW.phase='PREPARE' AND NEW.webhook_id IS NULL AND NEW.identity_recovery_id IS NULL AND archive.id IS NOT NULL
    AND NEW.signature_id=archive.signature_id AND NEW.attempt_id=archive.preparation_attempt_id AND NEW.provider_scope_hash=archive.provider_scope_hash AND NEW.provider_request_id=archive.provider_request_id
    AND NEW.provider_state='COMPLETED' AND NEW.contract_hash=archive.source_snapshot->>'contractHash' AND NEW.original_pdf_sha256=archive.source_snapshot->'document'->>'sha256' AND NEW.observed_at>=archive.admitted_at
    AND (SELECT count(*) FROM signature_signed_artifact a WHERE a.organization_id=NEW.organization_id AND a.archive_id=archive.id)=2,false)
  THEN RAISE EXCEPTION 'signed evidence requires its exact original archived pair'; END IF;
  SELECT * INTO history FROM signature_event WHERE organization_id=NEW.organization_id AND provider_evidence_id=NEW.id;
  IF NEW.kind='ARCHIVE_CAPTURED' THEN
    IF history.id IS NOT NULL OR (SELECT count(*) FROM signature_signed_artifact a WHERE a.organization_id=NEW.organization_id AND a.archive_id=archive.id AND a.xmin::text=pg_current_xact_id()::xid::text)<>2 OR EXISTS(SELECT 1 FROM signature_signed_artifact a JOIN document_version v ON v.organization_id=a.organization_id AND v.admission_id=a.admission_id WHERE a.organization_id=NEW.organization_id AND a.archive_id=archive.id)
    THEN RAISE EXCEPTION 'signed capture must atomically retain both encrypted originals before publication'; END IF;
  ELSE
    SELECT * INTO captured FROM signature_provider_evidence WHERE organization_id=NEW.organization_id AND signed_archive_id=archive.id AND kind='ARCHIVE_CAPTURED';
    IF captured.id IS NULL OR captured.xmin::text=pg_current_xact_id()::xid::text OR history.id IS NULL OR NOT app_native_signed_archive_event_valid(history)
      OR (SELECT count(*) FROM signature_signed_artifact a JOIN document_version v ON v.organization_id=a.organization_id AND v.admission_id=a.admission_id WHERE a.organization_id=NEW.organization_id AND a.archive_id=archive.id AND v.xmin::text=pg_current_xact_id()::xid::text)<>2
      OR NOT EXISTS(SELECT 1 FROM outbox_event e WHERE e.organization_id=NEW.organization_id AND e.type='documents.signature.signed_archived' AND e.payload=jsonb_build_object('archiveId',archive.id) AND e.idempotency_key='document-signed-archive-completed:'||archive.id::text AND e.xmin::text=pg_current_xact_id()::xid::text)
    THEN RAISE EXCEPTION 'native signed transition requires both separately captured objects and atomic audited versions'; END IF;
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER signed_archive_evidence_guard AFTER INSERT ON signature_provider_evidence DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app_guard_signed_archive_evidence();

CREATE OR REPLACE FUNCTION app_guard_document_signature_version() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE original signature%ROWTYPE;
BEGIN
  SELECT * INTO original FROM signature WHERE organization_id=NEW.organization_id AND id=NEW.signature_id;
  IF original.id IS NULL OR (NEW.signed_version_id IS NOT NULL AND NOT app_document_version_matches_instance(NEW.organization_id,NEW.signed_version_id,original.instance_id)
    AND NOT EXISTS(SELECT 1 FROM signature_provider_evidence e JOIN signature_signed_archive archive ON archive.organization_id=e.organization_id AND archive.id=e.signed_archive_id
      JOIN signature_signed_artifact a ON a.organization_id=archive.organization_id AND a.archive_id=archive.id AND a.kind='SIGNED_ORIGINAL'
      JOIN document_version v ON v.organization_id=a.organization_id AND v.admission_id=a.admission_id
      WHERE e.organization_id=NEW.organization_id AND e.id=NEW.provider_evidence_id AND e.kind='SIGNED' AND e.signature_id=original.id AND archive.signature_id=original.id AND v.id=NEW.signed_version_id AND NEW.state='SIGNED'))
  THEN RAISE EXCEPTION 'signature evidence cannot switch its original immutable generation instance'; END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION app_guard_signed_archive_reconciliation() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE archive signature_signed_archive%ROWTYPE; native signature%ROWTYPE; input jsonb; snapshot jsonb;
BEGIN
  IF NEW.action<>'SIGNED_ARCHIVE_RECONCILED' THEN RETURN NULL; END IF;
  snapshot:=NEW.before; input:=snapshot->'input';
  SELECT * INTO archive FROM signature_signed_archive WHERE organization_id=NEW.organization_id AND id=(snapshot->>'archiveId')::uuid;
  SELECT * INTO native FROM signature WHERE organization_id=NEW.organization_id AND id=archive.signature_id;
  IF NOT coalesce(NEW.actor_id IS NOT NULL AND snapshot->>'protocol'='ALVILLAS_SIGNED_SIGNATURE_ARCHIVE_V1' AND archive.id IS NOT NULL AND native.document_version_id::text=archive.source_snapshot->'document'->>'versionId'
    AND NEW.document_id::text=archive.source_snapshot->'document'->>'id' AND input->>'signatureId'=native.id::text AND input->>'idempotencyKey'=NEW.command_key::text AND input->>'reviewFingerprint' ~ '^[a-f0-9]{64}$' AND input->>'reason'=NEW.reason
    AND snapshot->'authorizationCap'->>'organizationId'=NEW.organization_id::text AND snapshot->'authorizationCap'->>'userAccountId'=NEW.actor_id::text
    AND (snapshot->>'canonicalRequest')::jsonb=jsonb_build_object('organizationId',NEW.organization_id,'actorId',NEW.actor_id,'input',input) AND encode(digest(snapshot->>'canonicalRequest','sha256'),'hex')=NEW.command_hash
    AND NEW.after=jsonb_build_object('signatureId',native.id,'archiveId',archive.id)
    AND EXISTS(SELECT 1 FROM outbox_event e WHERE e.organization_id=NEW.organization_id AND e.type='documents.signature.signed_archive_requested' AND e.payload=jsonb_build_object('archiveId',archive.id,'reconciliationId',NEW.id)
      AND e.idempotency_key='document-signed-archive-reconcile:'||NEW.actor_id::text||':'||NEW.command_key::text AND e.occurred_at=NEW.occurred_at AND e.xmin::text=pg_current_xact_id()::xid::text),false)
  THEN RAISE EXCEPTION 'signed archive reconciliation requires its original private command and reference'; END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER signed_archive_reconciliation_guard AFTER INSERT ON document_action DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app_guard_signed_archive_reconciliation();

CREATE FUNCTION app_guard_signed_archive_outbox() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE archive signature_signed_archive%ROWTYPE; command document_action%ROWTYPE;
BEGIN
  IF TG_OP='DELETE' THEN IF OLD.type IN('documents.signature.signed_archive_requested','documents.signature.signed_archived') THEN RAISE EXCEPTION 'signed archive outbox is retained'; END IF; RETURN OLD; END IF;
  IF TG_OP='UPDATE' THEN
    IF OLD.type IN('documents.signature.signed_archive_requested','documents.signature.signed_archived') OR NEW.type IN('documents.signature.signed_archive_requested','documents.signature.signed_archived') THEN
      IF ROW(NEW.id,NEW.organization_id,NEW.type,NEW.payload,NEW.idempotency_key,NEW.occurred_at,NEW.created_at) IS DISTINCT FROM ROW(OLD.id,OLD.organization_id,OLD.type,OLD.payload,OLD.idempotency_key,OLD.occurred_at,OLD.created_at) THEN RAISE EXCEPTION 'signed archive outbox keeps its original reference'; END IF;
    END IF; RETURN NEW;
  END IF;
  IF NEW.type NOT IN('documents.signature.signed_archive_requested','documents.signature.signed_archived') THEN RETURN NEW; END IF;
  SELECT * INTO archive FROM signature_signed_archive WHERE organization_id=NEW.organization_id AND id=(NEW.payload->>'archiveId')::uuid;
  IF archive.id IS NULL THEN RAISE EXCEPTION 'signed archive outbox requires its native admission'; END IF;
  IF NEW.type='documents.signature.signed_archived' THEN
    IF NEW.payload<>jsonb_build_object('archiveId',archive.id) OR NEW.idempotency_key<>'document-signed-archive-completed:'||archive.id::text OR NOT EXISTS(SELECT 1 FROM signature_provider_evidence e WHERE e.organization_id=NEW.organization_id AND e.signed_archive_id=archive.id AND e.kind='SIGNED' AND e.xmin::text=pg_current_xact_id()::xid::text)
    THEN RAISE EXCEPTION 'signed archive completion outbox requires atomic published evidence'; END IF;
  ELSIF NEW.payload ? 'reconciliationId' THEN
    SELECT * INTO command FROM document_action WHERE organization_id=NEW.organization_id AND id=(NEW.payload->>'reconciliationId')::uuid AND action='SIGNED_ARCHIVE_RECONCILED';
    IF NOT coalesce(command.actor_id IS NOT NULL AND command.before->>'archiveId'=archive.id::text AND NEW.payload=jsonb_build_object('archiveId',archive.id,'reconciliationId',command.id) AND NEW.idempotency_key='document-signed-archive-reconcile:'||command.actor_id::text||':'||command.command_key::text AND NEW.occurred_at=command.occurred_at AND EXISTS(SELECT 1 FROM document_action a WHERE a.organization_id=NEW.organization_id AND a.id=command.id AND a.xmin::text=pg_current_xact_id()::xid::text),false)
    THEN RAISE EXCEPTION 'signed archive retry requires its atomic private reconciliation'; END IF;
  ELSIF NEW.payload<>jsonb_build_object('archiveId',archive.id) OR NEW.idempotency_key<>'document-signed-archive:'||archive.id::text OR NEW.occurred_at<>archive.admitted_at OR NOT EXISTS(SELECT 1 FROM signature_signed_archive a WHERE a.organization_id=NEW.organization_id AND a.id=archive.id AND a.xmin::text=pg_current_xact_id()::xid::text)
  THEN RAISE EXCEPTION 'signed archive outbox requires its atomic original admission'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER signed_archive_outbox_guard BEFORE INSERT OR UPDATE OR DELETE ON outbox_event FOR EACH ROW EXECUTE FUNCTION app_guard_signed_archive_outbox();

CREATE OR REPLACE FUNCTION app_guard_document_signature_nonce() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE actor_uuid uuid;
BEGIN
  IF TG_TABLE_NAME='document_action' THEN IF NEW.action<>'SIGNED_ARCHIVE_RECONCILED' THEN RETURN NEW; END IF; actor_uuid:=NEW.actor_id;
  ELSIF TG_TABLE_NAME IN('signature','signature_provider_intent','signature_provider_identity_recovery') THEN actor_uuid:=NEW.requested_by; ELSE actor_uuid:=NEW.created_by; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.organization_id::text||':documents:nonce:'||actor_uuid::text||':'||NEW.command_key::text,0));
  IF TG_TABLE_NAME IN('signature','signature_provider_intent','signature_provider_identity_recovery','document_action') AND (
    EXISTS(SELECT 1 FROM document_admission WHERE organization_id=NEW.organization_id AND created_by=actor_uuid AND command_key=NEW.command_key)
    OR EXISTS(SELECT 1 FROM document_instance WHERE organization_id=NEW.organization_id AND created_by=actor_uuid AND command_key=NEW.command_key))
    OR TG_TABLE_NAME<>'signature' AND EXISTS(SELECT 1 FROM signature WHERE organization_id=NEW.organization_id AND requested_by=actor_uuid AND command_key=NEW.command_key)
    OR TG_TABLE_NAME<>'signature_provider_intent' AND EXISTS(SELECT 1 FROM signature_provider_intent WHERE organization_id=NEW.organization_id AND requested_by=actor_uuid AND command_key=NEW.command_key)
    OR TG_TABLE_NAME<>'signature_provider_identity_recovery' AND EXISTS(SELECT 1 FROM signature_provider_identity_recovery WHERE organization_id=NEW.organization_id AND requested_by=actor_uuid AND command_key=NEW.command_key)
    OR TG_TABLE_NAME<>'document_action' AND EXISTS(SELECT 1 FROM document_action WHERE organization_id=NEW.organization_id AND actor_id=actor_uuid AND command_key=NEW.command_key AND action='SIGNED_ARCHIVE_RECONCILED')
  THEN RAISE EXCEPTION 'document command nonce belongs to another protocol'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER signed_archive_reconciliation_nonce_guard BEFORE INSERT ON document_action FOR EACH ROW EXECUTE FUNCTION app_guard_document_signature_nonce();

CREATE OR REPLACE FUNCTION app_guard_native_signature_draft() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE original signature%ROWTYPE; instance document_instance%ROWTYPE; version document_version%ROWTYPE;
  admission document_admission%ROWTYPE; root document%ROWTYPE; rule config_rule%ROWTYPE;
  snapshot jsonb; command jsonb; captured jsonb; recipient signature_recipient%ROWTYPE; identity jsonb;
  expected jsonb; reference jsonb; actual_reference jsonb; recipient_count integer; boundary integer;
BEGIN
  IF TG_TABLE_NAME='signature' THEN original:=NEW;
  ELSE SELECT * INTO original FROM signature WHERE organization_id=NEW.organization_id AND id=NEW.signature_id; END IF;
  snapshot:=original.policy_snapshot;
  IF snapshot->>'protocol' IS DISTINCT FROM 'ALVILLAS_NATIVE_SIGNATURE_REQUEST_V1' THEN RETURN NULL; END IF;
  command:=snapshot->'command'; captured:=snapshot->'document';
  SELECT * INTO instance FROM document_instance WHERE organization_id=original.organization_id AND id=original.instance_id;
  SELECT * INTO version FROM document_version WHERE organization_id=original.organization_id AND id=original.document_version_id;
  SELECT * INTO admission FROM document_admission WHERE organization_id=original.organization_id AND id=version.admission_id;
  SELECT * INTO root FROM document WHERE organization_id=original.organization_id AND id=instance.document_id;
  SELECT * INTO rule FROM config_rule WHERE organization_id=original.organization_id AND id=(snapshot->'archivePolicy'->>'id')::uuid;
  IF NOT coalesce(snapshot->>'schemaVersion'='1' AND jsonb_typeof(command)='object' AND jsonb_typeof(captured)='object'
    AND snapshot->>'commandHash'=original.command_hash AND snapshot->>'nativeSourceFingerprint'=original.source_fingerprint
    AND snapshot->>'archiveFingerprint' ~ '^[a-f0-9]{64}$'
    AND command->>'instanceId'=original.instance_id::text AND command->>'documentVersionId'=original.document_version_id::text
    AND command->>'idempotencyKey'=original.command_key::text AND command->>'reason'=original.reason
    AND command->>'reviewFingerprint' ~ '^[a-f0-9]{64}$'
    AND original.authorization_cap->>'schemaVersion'='1' AND original.authorization_cap->>'organizationId'=original.organization_id::text
    AND original.authorization_cap->>'userAccountId'=original.requested_by::text
    AND instance.id IS NOT NULL AND version.id IS NOT NULL AND root.id IS NOT NULL
    AND app_document_version_matches_instance(original.organization_id,version.id,instance.id)
    AND admission.content_type='application/pdf' AND admission.input->>'generationInstanceId'=instance.id::text
    AND captured->>'id'=root.id::text AND captured->>'instanceId'=instance.id::text AND captured->>'versionId'=version.id::text
    AND captured->>'admissionId'=admission.id::text AND captured->>'sha256'=admission.sha256
    AND captured->>'byteSize'=admission.file_size::text AND captured->>'locale'=root.locale
    AND captured->'source'=jsonb_build_object('kind',root.source_kind,'id',root.source_id)
    AND rule.id IS NOT NULL AND rule.key='documents.archive' AND snapshot->'archivePolicy'->'value'=rule.value
    AND snapshot->'archivePolicy'->>'version'=rule.version::text
    AND jsonb_typeof(snapshot->'recipients')='array' AND jsonb_typeof(command->'recipients')='array',false)
  THEN RAISE EXCEPTION 'native signature draft requires its exact archived instance and captured policy'; END IF;
  recipient_count:=jsonb_array_length(snapshot->'recipients');
  IF recipient_count NOT BETWEEN 1 AND 100 OR recipient_count<>jsonb_array_length(command->'recipients')
    OR recipient_count<>(SELECT count(*) FROM signature_recipient WHERE organization_id=original.organization_id AND signature_id=original.id)
  THEN RAISE EXCEPTION 'native signature draft requires its exact captured recipients'; END IF;
  FOR expected IN SELECT value FROM jsonb_array_elements(snapshot->'recipients') LOOP
    reference:=expected->'reference';
    IF NOT coalesce(reference->>'kind' IN ('PERSON','OWNER','GUEST','SUPPLIER') AND expected->>'fingerprint' ~ '^[a-f0-9]{64}$'
      AND expected->>'identityHash'=encode(digest('{"kind":'||to_json(reference->>'kind')::text||',"id":'||to_json(reference->>'id')::text||'}','sha256'),'hex')
      AND (SELECT count(*) FROM jsonb_array_elements(command->'recipients') r WHERE r=reference)=1
      AND (SELECT count(*) FROM jsonb_array_elements(snapshot->'recipients') r WHERE r->'reference'=reference)=1,false)
    THEN RAISE EXCEPTION 'native signature draft recipient identity cannot be substituted'; END IF;
    SELECT * INTO recipient FROM signature_recipient WHERE organization_id=original.organization_id AND signature_id=original.id AND identity_hash=expected->>'identityHash';
    identity:=jsonb_build_object('organizationId',original.organization_id,'signatureId',original.id,'recipientId',recipient.id,'reference',reference,'fingerprint',expected->>'fingerprint');
    actual_reference:=CASE WHEN recipient.person_id IS NOT NULL THEN jsonb_build_object('kind','PERSON','id',recipient.person_id)
      WHEN recipient.owner_id IS NOT NULL THEN jsonb_build_object('kind','OWNER','id',recipient.owner_id)
      WHEN recipient.guest_id IS NOT NULL THEN jsonb_build_object('kind','GUEST','id',recipient.guest_id)
      ELSE jsonb_build_object('kind','SUPPLIER','id',recipient.supplier_id) END;
    boundary:=position(decode('0a','hex') in recipient.email_cipher);
    IF NOT coalesce(recipient.id IS NOT NULL AND actual_reference=reference AND recipient.created_at=original.requested_at
      AND recipient.source_snapshot=jsonb_build_object('protocol','ALVILLAS_NATIVE_SIGNATURE_RECIPIENT_V1','schemaVersion',1,'identity',identity)
      AND boundary BETWEEN 1 AND 256 AND octet_length(recipient.email_cipher)>boundary AND octet_length(recipient.email_cipher)<=8448
      AND convert_from(substring(recipient.email_cipher FROM 1 FOR greatest(boundary-1,0)),'UTF8') ~ '^alvillas-binary-v1:[^:]{1,180}:[A-Za-z0-9_-]{16}:[A-Za-z0-9_-]{22}$',false)
    THEN RAISE EXCEPTION 'native signature draft requires identity-bound encrypted recipient evidence'; END IF;
  END LOOP;
  -- Provider and archival transitions require their own durable evidence protocol. A recipient
  -- event, an unverified webhook, or an arbitrary provider ID cannot turn this draft into SIGNED.
  IF (SELECT count(*) FROM signature_event WHERE organization_id=original.organization_id AND signature_id=original.id AND state='DRAFT')<>1
    OR EXISTS(SELECT 1 FROM signature_event e WHERE e.organization_id=original.organization_id AND e.signature_id=original.id AND e.state='DRAFT' AND e.provider_evidence_id IS NOT NULL)
    OR EXISTS(SELECT 1 FROM signature_event e WHERE e.organization_id=original.organization_id AND e.signature_id=original.id AND e.state<>'DRAFT' AND NOT(app_native_signature_distribution_event_valid(e) OR app_native_signature_webhook_event_valid(e) OR app_native_signed_archive_event_valid(e)))
    OR NOT EXISTS(SELECT 1 FROM signature_event WHERE organization_id=original.organization_id AND signature_id=original.id
      AND state='DRAFT' AND evidence_hash=original.command_hash AND occurred_at=original.requested_at AND observed_at=original.requested_at)
  THEN RAISE EXCEPTION 'native signature transition requires its durable provider and archive protocol'; END IF;
  IF TG_TABLE_NAME='signature' THEN
    IF NOT EXISTS(SELECT 1 FROM document_action a WHERE a.organization_id=original.organization_id AND a.document_id=root.id
      AND a.action='SIGNATURE_CREATED' AND a.actor_id=original.requested_by AND a.occurred_at=original.requested_at
      AND a.command_key=original.command_key AND a.command_hash=original.command_hash AND a.reason=original.reason
      AND a.source_fingerprint=original.source_fingerprint AND a.before='{}'::jsonb
      AND a.after=jsonb_build_object('signatureId',original.id,'instanceId',instance.id,'versionId',version.id,'recipientCount',recipient_count)
      AND a.xmin::text=pg_current_xact_id()::xid::text)
      OR NOT EXISTS(SELECT 1 FROM outbox_event e WHERE e.organization_id=original.organization_id AND e.type='documents.signature.draft_created'
        AND e.payload=jsonb_build_object('signatureId',original.id)
        AND e.idempotency_key='document-signature-draft:'||original.requested_by::text||':'||original.command_key::text
        AND e.occurred_at=original.requested_at AND e.xmin::text=pg_current_xact_id()::xid::text)
      OR EXISTS(SELECT 1 FROM document_admission WHERE organization_id=original.organization_id AND created_by=original.requested_by AND command_key=original.command_key)
      OR EXISTS(SELECT 1 FROM document_instance WHERE organization_id=original.organization_id AND created_by=original.requested_by AND command_key=original.command_key)
    THEN RAISE EXCEPTION 'native signature draft requires atomic private history and reference-only outbox'; END IF;
    PERFORM app_document_action_required(original.organization_id,root.id,'SIGNATURE_CREATED',original.requested_by,original.requested_at);
  END IF;
  RETURN NULL;
END $$;

COMMIT;
