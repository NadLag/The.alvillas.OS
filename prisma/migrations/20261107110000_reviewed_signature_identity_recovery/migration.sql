BEGIN;

-- AlterTable
ALTER TABLE "signature_provider_evidence" ADD COLUMN     "identity_recovery_id" UUID;

-- CreateTable
CREATE TABLE "signature_provider_identity_recovery" (
    "id" UUID NOT NULL DEFAULT app_uuid_v7(),
    "organization_id" UUID NOT NULL,
    "signature_id" UUID NOT NULL,
    "preparation_attempt_id" UUID NOT NULL,
    "webhook_id" UUID NOT NULL,
    "provider_scope_hash" CHAR(64) NOT NULL,
    "provider_request_id" TEXT NOT NULL,
    "command_key" UUID NOT NULL,
    "command_hash" CHAR(64) NOT NULL,
    "canonical_request" TEXT NOT NULL,
    "input" JSONB NOT NULL,
    "source_fingerprint" CHAR(64) NOT NULL,
    "policy_snapshot" JSONB NOT NULL,
    "authorization_cap" JSONB NOT NULL,
    "reason" TEXT NOT NULL,
    "requested_by" UUID NOT NULL,
    "requested_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "signature_provider_identity_recovery_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "signature_identity_recovery_history_idx" ON "signature_provider_identity_recovery"("organization_id", "signature_id", "requested_at", "id");

-- CreateIndex
CREATE INDEX "signature_identity_recovery_nonce_owner_idx" ON "signature_provider_identity_recovery"("organization_id", "command_key");

-- CreateIndex
CREATE UNIQUE INDEX "signature_identity_recovery_org_id_unique" ON "signature_provider_identity_recovery"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "signature_identity_recovery_nonce_unique" ON "signature_provider_identity_recovery"("organization_id", "requested_by", "command_key");

-- AddForeignKey
ALTER TABLE "signature_provider_evidence" ADD CONSTRAINT "signature_provider_evidence_organization_id_identity_recov_fkey" FOREIGN KEY ("organization_id", "identity_recovery_id") REFERENCES "signature_provider_identity_recovery"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "signature_provider_identity_recovery" ADD CONSTRAINT "signature_provider_identity_recovery_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "signature_provider_identity_recovery" ADD CONSTRAINT "signature_provider_identity_recovery_organization_id_signa_fkey" FOREIGN KEY ("organization_id", "signature_id") REFERENCES "signature"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "signature_provider_identity_recovery" ADD CONSTRAINT "signature_provider_identity_recovery_organization_id_prepa_fkey" FOREIGN KEY ("organization_id", "preparation_attempt_id") REFERENCES "signature_provider_attempt"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "signature_provider_identity_recovery" ADD CONSTRAINT "signature_provider_identity_recovery_organization_id_webho_fkey" FOREIGN KEY ("organization_id", "webhook_id") REFERENCES "signature_provider_webhook"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "signature_provider_identity_recovery" ADD CONSTRAINT "signature_provider_identity_recovery_organization_id_provi_fkey" FOREIGN KEY ("organization_id", "provider_scope_hash") REFERENCES "signature_provider_scope"("organization_id", "scope_hash") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "signature_provider_identity_recovery" ADD CONSTRAINT "signature_provider_identity_recovery_organization_id_reque_fkey" FOREIGN KEY ("organization_id", "requested_by") REFERENCES "user_account"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;


ALTER TABLE signature_provider_identity_recovery ENABLE ROW LEVEL SECURITY;
ALTER TABLE signature_provider_identity_recovery FORCE ROW LEVEL SECURITY;
CREATE POLICY signature_provider_identity_recovery_tenant_isolation ON signature_provider_identity_recovery
  USING(organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid)
  WITH CHECK(organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid);
CREATE TRIGGER signature_identity_recovery_immutable BEFORE UPDATE OR DELETE ON signature_provider_identity_recovery FOR EACH ROW EXECUTE FUNCTION app_document_append_only();
CREATE UNIQUE INDEX signature_provider_evidence_identity_recovery_unique ON signature_provider_evidence(organization_id,identity_recovery_id);

ALTER TABLE signature_provider_identity_recovery ADD CONSTRAINT signature_identity_recovery_shape CHECK(coalesce(
  command_hash ~ '^[a-f0-9]{64}$' AND source_fingerprint ~ '^[a-f0-9]{64}$' AND provider_scope_hash ~ '^[a-f0-9]{64}$'
  AND provider_request_id ~ '^[A-Za-z0-9_-]{1,255}$' AND char_length(reason) BETWEEN 8 AND 1000
  AND jsonb_typeof(input)='object' AND jsonb_typeof(policy_snapshot)='object' AND jsonb_typeof(authorization_cap)='object',false));

CREATE OR REPLACE FUNCTION app_guard_document_signature_nonce() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE actor_uuid uuid;
BEGIN
  IF TG_TABLE_NAME IN('signature','signature_provider_intent','signature_provider_identity_recovery') THEN actor_uuid:=NEW.requested_by; ELSE actor_uuid:=NEW.created_by; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.organization_id::text||':documents:nonce:'||actor_uuid::text||':'||NEW.command_key::text,0));
  IF TG_TABLE_NAME IN('signature','signature_provider_intent','signature_provider_identity_recovery') AND (
    EXISTS(SELECT 1 FROM document_admission WHERE organization_id=NEW.organization_id AND created_by=actor_uuid AND command_key=NEW.command_key)
    OR EXISTS(SELECT 1 FROM document_instance WHERE organization_id=NEW.organization_id AND created_by=actor_uuid AND command_key=NEW.command_key))
    OR TG_TABLE_NAME<>'signature' AND EXISTS(SELECT 1 FROM signature WHERE organization_id=NEW.organization_id AND requested_by=actor_uuid AND command_key=NEW.command_key)
    OR TG_TABLE_NAME<>'signature_provider_intent' AND EXISTS(SELECT 1 FROM signature_provider_intent WHERE organization_id=NEW.organization_id AND requested_by=actor_uuid AND command_key=NEW.command_key)
    OR TG_TABLE_NAME<>'signature_provider_identity_recovery' AND EXISTS(SELECT 1 FROM signature_provider_identity_recovery WHERE organization_id=NEW.organization_id AND requested_by=actor_uuid AND command_key=NEW.command_key)
  THEN RAISE EXCEPTION 'document command nonce belongs to another protocol'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER signature_identity_recovery_nonce_guard BEFORE INSERT ON signature_provider_identity_recovery FOR EACH ROW EXECUTE FUNCTION app_guard_document_signature_nonce();

CREATE FUNCTION app_guard_signature_identity_recovery() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE original signature_provider_intent%ROWTYPE; attempt signature_provider_attempt%ROWTYPE; inbox signature_provider_webhook%ROWTYPE; native signature%ROWTYPE; snapshot jsonb;
BEGIN
  snapshot:=NEW.policy_snapshot;
  SELECT * INTO attempt FROM signature_provider_attempt WHERE organization_id=NEW.organization_id AND id=NEW.preparation_attempt_id;
  SELECT * INTO original FROM signature_provider_intent WHERE organization_id=NEW.organization_id AND id=attempt.intent_id;
  SELECT * INTO inbox FROM signature_provider_webhook WHERE organization_id=NEW.organization_id AND id=NEW.webhook_id;
  SELECT * INTO native FROM signature WHERE organization_id=NEW.organization_id AND id=NEW.signature_id;
  IF NOT coalesce(attempt.id IS NOT NULL AND original.id IS NOT NULL AND inbox.id IS NOT NULL AND native.id IS NOT NULL
    AND attempt.phase='PREPARE' AND original.phase='PREPARE' AND original.signature_id=NEW.signature_id AND attempt.signature_id=NEW.signature_id
    AND original.policy_snapshot->>'protocol'='ALVILLAS_SIGNATURE_PREPARATION_V1' AND native.policy_snapshot->>'protocol'='ALVILLAS_NATIVE_SIGNATURE_REQUEST_V1'
    AND inbox.signature_id=NEW.signature_id AND inbox.preparation_attempt_id=attempt.id AND inbox.provider_scope_hash=NEW.provider_scope_hash
    AND inbox.provider_request_id=NEW.provider_request_id AND original.provider_scope_hash=NEW.provider_scope_hash AND NEW.requested_at>=inbox.received_at
    AND snapshot->>'protocol'='ALVILLAS_SIGNATURE_IDENTITY_RECOVERY_V1' AND snapshot->>'schemaVersion'='1'
    AND snapshot->'command'=NEW.input AND snapshot->>'commandHash'=NEW.command_hash AND snapshot->>'signatureId'=NEW.signature_id::text
    AND snapshot->>'signatureCommandHash'=native.command_hash AND snapshot->>'contextFingerprint'=NEW.source_fingerprint
    AND snapshot->>'contractHash'=original.policy_snapshot->>'contractHash' AND snapshot->>'providerScopeHash'=NEW.provider_scope_hash
    AND snapshot->>'reviewedIdentityHash' ~ '^[a-f0-9]{64}$' AND snapshot->'document'=original.policy_snapshot->'document'
    AND snapshot->'providerPolicy'=original.policy_snapshot->'providerPolicy'
    AND snapshot->'original'->>'intentId'=original.id::text AND snapshot->'original'->>'attemptId'=attempt.id::text
    AND snapshot->'original'->>'webhookId'=inbox.id::text AND snapshot->'original'->>'providerRequestId'=NEW.provider_request_id
    AND snapshot->'original' ? 'providerCreatedAt'
    AND NEW.input->>'signatureId'=NEW.signature_id::text AND NEW.input->>'webhookId'=NEW.webhook_id::text
    AND NEW.input->>'idempotencyKey'=NEW.command_key::text AND NEW.input->>'reason'=NEW.reason AND NEW.input->>'reviewFingerprint' ~ '^[a-f0-9]{64}$'
    AND NEW.canonical_request::jsonb=jsonb_build_object('organizationId',NEW.organization_id,'actorId',NEW.requested_by,'input',NEW.input)
    AND encode(digest(NEW.canonical_request,'sha256'),'hex')=NEW.command_hash
    AND NEW.authorization_cap->>'schemaVersion'='1' AND NEW.authorization_cap->>'organizationId'=NEW.organization_id::text
    AND NEW.authorization_cap->>'userAccountId'=NEW.requested_by::text AND NEW.authorization_cap->'permissions' ?& ARRAY['signature:view','signature:edit','document:view','document:export','document_instance:export'],false)
    OR EXISTS(SELECT 1 FROM jsonb_object_keys(NEW.input) k WHERE k NOT IN('signatureId','webhookId','idempotencyKey','reviewFingerprint','reason'))
  THEN RAISE EXCEPTION 'identity recovery requires an exact reviewed original, held actor and retained authenticated candidate'; END IF;
  IF NOT EXISTS(SELECT 1 FROM audit_log a WHERE a.organization_id=NEW.organization_id AND a.actor_id=NEW.requested_by AND a.resource_type='signature' AND a.resource_id=NEW.id
    AND a.action='documents.signature.identity_recovery_requested' AND a.occurred_at=NEW.requested_at
    AND a.after=jsonb_build_object('signatureId',NEW.signature_id,'recoveryId',NEW.id,'webhookId',NEW.webhook_id,'commandHash',NEW.command_hash,'identityHash',snapshot->>'reviewedIdentityHash')
    AND a.xmin::text=pg_current_xact_id()::xid::text)
    OR NOT EXISTS(SELECT 1 FROM outbox_event e WHERE e.organization_id=NEW.organization_id AND e.type='documents.signature.identity_recovery_requested'
      AND e.payload=jsonb_build_object('recoveryId',NEW.id) AND e.idempotency_key='document-signature-identity:'||NEW.requested_by::text||':'||NEW.command_key::text
      AND e.occurred_at=NEW.requested_at AND e.xmin::text=pg_current_xact_id()::xid::text)
  THEN RAISE EXCEPTION 'identity recovery requires atomic actor audit and reference-only outbox'; END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER signature_identity_recovery_guard AFTER INSERT ON signature_provider_identity_recovery DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app_guard_signature_identity_recovery();

CREATE FUNCTION app_guard_signature_identity_binding() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE recovery signature_provider_identity_recovery%ROWTYPE; attempt signature_provider_attempt%ROWTYPE;
BEGIN
  IF NEW.phase='PREPARE' AND NEW.webhook_id IS NULL AND NEW.provider_request_id IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(hashtextextended(NEW.organization_id::text||':documents:signature-provider:'||NEW.signature_id::text,0));
    IF EXISTS(SELECT 1 FROM signature_provider_evidence e WHERE e.organization_id=NEW.organization_id AND e.attempt_id=NEW.attempt_id
      AND e.webhook_id IS NULL AND e.provider_request_id IS NOT NULL AND e.provider_request_id<>NEW.provider_request_id)
    THEN RAISE EXCEPTION 'an original signature attempt cannot acquire a different provider identity'; END IF;
  END IF;
  IF NEW.identity_recovery_id IS NULL THEN RETURN NEW; END IF;
  SELECT * INTO recovery FROM signature_provider_identity_recovery WHERE organization_id=NEW.organization_id AND id=NEW.identity_recovery_id;
  SELECT * INTO attempt FROM signature_provider_attempt WHERE organization_id=NEW.organization_id AND id=NEW.attempt_id;
  IF NOT coalesce(recovery.id IS NOT NULL AND attempt.id=recovery.preparation_attempt_id AND attempt.phase='PREPARE' AND NEW.phase='PREPARE'
    AND attempt.intent_id::text=recovery.policy_snapshot->'original'->>'intentId' AND NEW.webhook_id IS NULL AND NEW.kind IN('PREPARED','UNCERTAIN')
    AND NEW.signature_id=recovery.signature_id AND NEW.provider_scope_hash=recovery.provider_scope_hash AND NEW.provider_request_id=recovery.provider_request_id
    AND NEW.contract_hash=recovery.policy_snapshot->>'contractHash' AND NEW.original_pdf_sha256=recovery.policy_snapshot->'document'->>'sha256'
    AND NEW.observed_at>=recovery.requested_at AND EXISTS(SELECT 1 FROM signature_provider_identity_recovery r WHERE r.organization_id=NEW.organization_id AND r.id=recovery.id AND r.xmin::text<>pg_current_xact_id()::xid::text),false)
  THEN RAISE EXCEPTION 'reviewed identity evidence requires its separately committed original recovery command'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER signature_identity_binding_guard BEFORE INSERT ON signature_provider_evidence FOR EACH ROW EXECUTE FUNCTION app_guard_signature_identity_binding();

CREATE FUNCTION app_guard_signature_identity_outbox() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE original signature_provider_identity_recovery%ROWTYPE;
BEGIN
  IF TG_OP='DELETE' THEN IF OLD.type='documents.signature.identity_recovery_requested' THEN RAISE EXCEPTION 'native identity recovery outbox is retained'; END IF; RETURN OLD; END IF;
  IF TG_OP='UPDATE' THEN
    IF OLD.type='documents.signature.identity_recovery_requested' OR NEW.type='documents.signature.identity_recovery_requested' THEN
      IF ROW(NEW.id,NEW.organization_id,NEW.type,NEW.payload,NEW.idempotency_key,NEW.occurred_at,NEW.created_at) IS DISTINCT FROM ROW(OLD.id,OLD.organization_id,OLD.type,OLD.payload,OLD.idempotency_key,OLD.occurred_at,OLD.created_at) THEN RAISE EXCEPTION 'native identity recovery outbox keeps its original reference'; END IF;
    END IF; RETURN NEW;
  END IF;
  IF NEW.type<>'documents.signature.identity_recovery_requested' THEN RETURN NEW; END IF;
  IF jsonb_typeof(NEW.payload)<>'object' OR NOT coalesce(NEW.payload->>'recoveryId' ~ '^[a-f0-9-]{36}$',false) THEN RAISE EXCEPTION 'identity recovery outbox requires its native reference'; END IF;
  SELECT * INTO original FROM signature_provider_identity_recovery WHERE organization_id=NEW.organization_id AND id=(NEW.payload->>'recoveryId')::uuid;
  IF NOT coalesce(original.id IS NOT NULL AND NEW.payload=jsonb_build_object('recoveryId',original.id) AND NEW.idempotency_key='document-signature-identity:'||original.requested_by::text||':'||original.command_key::text AND NEW.occurred_at=original.requested_at
    AND EXISTS(SELECT 1 FROM signature_provider_identity_recovery r WHERE r.organization_id=NEW.organization_id AND r.id=original.id AND r.xmin::text=pg_current_xact_id()::xid::text),false)
  THEN RAISE EXCEPTION 'identity recovery outbox requires its atomic original admission'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER signature_identity_outbox_guard BEFORE INSERT OR UPDATE OR DELETE ON outbox_event FOR EACH ROW EXECUTE FUNCTION app_guard_signature_identity_outbox();

COMMIT;
