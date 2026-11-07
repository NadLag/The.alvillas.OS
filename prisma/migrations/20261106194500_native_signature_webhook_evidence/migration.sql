BEGIN;

-- AlterTable
ALTER TABLE "signature_provider_evidence" ADD COLUMN     "webhook_id" UUID;

-- CreateTable
CREATE TABLE "signature_provider_webhook" (
    "id" UUID NOT NULL DEFAULT app_uuid_v7(),
    "organization_id" UUID NOT NULL,
    "signature_id" UUID NOT NULL,
    "preparation_attempt_id" UUID NOT NULL,
    "provider_scope_hash" CHAR(64) NOT NULL,
    "provider_request_id" TEXT NOT NULL,
    "provider_event_id" CHAR(64) NOT NULL,
    "event_type" TEXT NOT NULL,
    "payload_sha256" CHAR(64) NOT NULL,
    "payload_byte_size" INTEGER NOT NULL,
    "payload_cipher" BYTEA NOT NULL,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL,
    "received_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "signature_provider_webhook_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "signature_provider_webhook_history_idx" ON "signature_provider_webhook"("organization_id", "signature_id", "received_at", "id");

-- CreateIndex
CREATE UNIQUE INDEX "signature_provider_webhook_org_id_unique" ON "signature_provider_webhook"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "signature_provider_webhook_dedup_unique" ON "signature_provider_webhook"("organization_id", "provider_scope_hash", "provider_event_id");

-- AddForeignKey
ALTER TABLE "signature_provider_evidence" ADD CONSTRAINT "signature_provider_evidence_organization_id_webhook_id_fkey" FOREIGN KEY ("organization_id", "webhook_id") REFERENCES "signature_provider_webhook"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "signature_provider_webhook" ADD CONSTRAINT "signature_provider_webhook_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "signature_provider_webhook" ADD CONSTRAINT "signature_provider_webhook_organization_id_signature_id_fkey" FOREIGN KEY ("organization_id", "signature_id") REFERENCES "signature"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "signature_provider_webhook" ADD CONSTRAINT "signature_provider_webhook_organization_id_preparation_att_fkey" FOREIGN KEY ("organization_id", "preparation_attempt_id") REFERENCES "signature_provider_attempt"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "signature_provider_webhook" ADD CONSTRAINT "signature_provider_webhook_organization_id_provider_scope__fkey" FOREIGN KEY ("organization_id", "provider_scope_hash") REFERENCES "signature_provider_scope"("organization_id", "scope_hash") ON DELETE RESTRICT ON UPDATE NO ACTION;

ALTER TABLE signature_provider_webhook ENABLE ROW LEVEL SECURITY;
ALTER TABLE signature_provider_webhook FORCE ROW LEVEL SECURITY;
CREATE POLICY signature_provider_webhook_tenant_isolation ON signature_provider_webhook
  USING(organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid)
  WITH CHECK(organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid);
CREATE TRIGGER signature_provider_webhook_immutable BEFORE UPDATE OR DELETE ON signature_provider_webhook FOR EACH ROW EXECUTE FUNCTION app_document_append_only();

ALTER TABLE signature_provider_webhook ADD CONSTRAINT signature_provider_webhook_shape CHECK(coalesce(
  provider_scope_hash ~ '^[a-f0-9]{64}$' AND provider_event_id ~ '^[a-f0-9]{64}$' AND payload_sha256 ~ '^[a-f0-9]{64}$'
  AND provider_request_id ~ '^[A-Za-z0-9_-]{1,255}$' AND payload_byte_size BETWEEN 1 AND 1048576
  AND octet_length(payload_cipher)>payload_byte_size AND octet_length(payload_cipher)<=payload_byte_size+256
  AND event_type IN('DOCUMENT_CREATED','DOCUMENT_SENT','DOCUMENT_OPENED','DOCUMENT_SIGNED','DOCUMENT_COMPLETED','DOCUMENT_REJECTED','DOCUMENT_CANCELLED','DOCUMENT_RECIPIENT_COMPLETED','RECIPIENT_EXPIRED'),false));

ALTER TABLE signature_provider_evidence DROP CONSTRAINT signature_provider_evidence_shape;
ALTER TABLE signature_provider_evidence ADD CONSTRAINT signature_provider_evidence_shape CHECK(coalesce(
  phase IN('PREPARE','SEND') AND provider_scope_hash ~ '^[a-f0-9]{64}$'
  AND original_pdf_sha256 ~ '^[a-f0-9]{64}$' AND contract_hash ~ '^[a-f0-9]{64}$' AND observation_hash ~ '^[a-f0-9]{64}$' AND payload_sha256 ~ '^[a-f0-9]{64}$'
  AND payload_byte_size BETWEEN 1 AND 4194304 AND octet_length(payload_cipher)>payload_byte_size AND octet_length(payload_cipher)<=payload_byte_size+256
  AND (provider_request_id IS NULL OR provider_request_id ~ '^[A-Za-z0-9_-]{1,255}$')
  AND ((webhook_id IS NULL AND ((kind='PREPARED' AND phase='PREPARE' AND provider_request_id IS NOT NULL AND provider_state='DRAFT')
    OR (kind='SENT' AND phase='SEND' AND provider_request_id IS NOT NULL AND provider_state IN('PENDING','COMPLETED')) OR(kind='UNCERTAIN' AND provider_state IS NULL)))
   OR (webhook_id IS NOT NULL AND phase='PREPARE' AND provider_request_id IS NOT NULL
    AND ((kind='SENT' AND provider_state IN('PENDING','COMPLETED')) OR(kind='VIEWED' AND provider_state IN('PENDING','COMPLETED','REJECTED','CANCELLED'))
     OR(kind='DECLINED' AND provider_state IN('PENDING','REJECTED')) OR(kind='EXPIRED' AND provider_state='PENDING') OR(kind='COMPLETION' AND provider_state='COMPLETED')
     OR(kind='OBSERVED' AND provider_state IN('DRAFT','PENDING','COMPLETED','REJECTED','CANCELLED')) OR(kind='UNCERTAIN' AND provider_state IS NULL)))),false));
CREATE UNIQUE INDEX signature_provider_webhook_confirmed_unique ON signature_provider_evidence(organization_id,webhook_id,kind) WHERE webhook_id IS NOT NULL AND kind<>'UNCERTAIN';

CREATE FUNCTION app_guard_signature_provider_webhook() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE attempt signature_provider_attempt%ROWTYPE; original signature_provider_intent%ROWTYPE; boundary integer;
BEGIN
  SELECT * INTO attempt FROM signature_provider_attempt WHERE organization_id=NEW.organization_id AND id=NEW.preparation_attempt_id;
  SELECT * INTO original FROM signature_provider_intent WHERE organization_id=NEW.organization_id AND id=attempt.intent_id;
  boundary:=position(decode('0a','hex') in NEW.payload_cipher);
  IF NOT coalesce(attempt.id IS NOT NULL AND attempt.phase='PREPARE' AND original.phase='PREPARE' AND original.signature_id=NEW.signature_id AND attempt.signature_id=NEW.signature_id
    AND original.policy_snapshot->>'protocol'='ALVILLAS_SIGNATURE_PREPARATION_V1' AND original.provider_scope_hash=NEW.provider_scope_hash AND NEW.received_at>=attempt.started_at
    AND EXISTS(SELECT 1 FROM signature_provider_scope s WHERE s.organization_id=NEW.organization_id AND s.scope_hash=NEW.provider_scope_hash)
    AND boundary BETWEEN 1 AND 256 AND octet_length(NEW.payload_cipher)-boundary=NEW.payload_byte_size
    AND convert_from(substring(NEW.payload_cipher FROM 1 FOR greatest(boundary-1,0)),'UTF8') ~ '^alvillas-binary-v1:[^:]{1,180}:[A-Za-z0-9_-]{16}:[A-Za-z0-9_-]{22}$',false)
    OR EXISTS(SELECT 1 FROM signature_provider_evidence e WHERE e.organization_id=NEW.organization_id AND e.attempt_id=attempt.id AND e.webhook_id IS NULL AND e.provider_request_id IS NOT NULL AND e.provider_request_id<>NEW.provider_request_id)
    OR NOT EXISTS(SELECT 1 FROM audit_log a WHERE a.organization_id=NEW.organization_id AND a.actor_id IS NULL AND a.action='documents.signature.webhook_received' AND a.resource_type='signature' AND a.resource_id=NEW.id AND a.occurred_at=NEW.received_at
      AND a.after=jsonb_build_object('signatureId',NEW.signature_id,'webhookId',NEW.id,'preparationAttemptId',NEW.preparation_attempt_id,'providerScopeHash',NEW.provider_scope_hash,'providerEventId',NEW.provider_event_id,'payloadSha256',NEW.payload_sha256)
      AND a.xmin::text=pg_current_xact_id()::xid::text)
    OR NOT EXISTS(SELECT 1 FROM outbox_event e WHERE e.organization_id=NEW.organization_id AND e.type='documents.signature.webhook_received' AND e.payload=jsonb_build_object('webhookId',NEW.id)
      AND e.idempotency_key='document-signature-webhook:'||NEW.id::text AND e.occurred_at=NEW.received_at AND e.xmin::text=pg_current_xact_id()::xid::text)
  THEN RAISE EXCEPTION 'native signature webhook requires its original preparation attempt, encrypted body, account and atomic audit/outbox'; END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER signature_provider_webhook_guard AFTER INSERT ON signature_provider_webhook DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app_guard_signature_provider_webhook();

CREATE FUNCTION app_guard_signature_webhook_outbox() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE original signature_provider_webhook%ROWTYPE;
BEGIN
  IF TG_OP='DELETE' THEN IF OLD.type='documents.signature.webhook_received' THEN RAISE EXCEPTION 'native signature webhook outbox history is immutable'; END IF; RETURN OLD; END IF;
  IF TG_OP='UPDATE' THEN
    IF OLD.type='documents.signature.webhook_received' OR NEW.type='documents.signature.webhook_received' THEN
      IF NEW.organization_id IS DISTINCT FROM OLD.organization_id OR NEW.id IS DISTINCT FROM OLD.id OR NEW.type IS DISTINCT FROM OLD.type OR NEW.payload IS DISTINCT FROM OLD.payload OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key OR NEW.occurred_at IS DISTINCT FROM OLD.occurred_at
      THEN RAISE EXCEPTION 'native signature webhook outbox reference is immutable'; END IF;
    END IF; RETURN NEW;
  END IF;
  IF NEW.type<>'documents.signature.webhook_received' THEN RETURN NEW; END IF;
  IF jsonb_typeof(NEW.payload)<>'object' OR NOT coalesce(NEW.payload->>'webhookId' ~ '^[a-f0-9-]{36}$',false) THEN RAISE EXCEPTION 'native signature webhook outbox requires its exact original reference'; END IF;
  SELECT * INTO original FROM signature_provider_webhook WHERE organization_id=NEW.organization_id AND id=(NEW.payload->>'webhookId')::uuid;
  IF NOT coalesce(original.id IS NOT NULL AND NEW.payload=jsonb_build_object('webhookId',original.id) AND NEW.idempotency_key='document-signature-webhook:'||original.id::text AND NEW.occurred_at=original.received_at
    AND EXISTS(SELECT 1 FROM signature_provider_webhook actual WHERE actual.organization_id=NEW.organization_id AND actual.id=original.id AND actual.xmin::text=pg_current_xact_id()::xid::text),false)
  THEN RAISE EXCEPTION 'native signature webhook outbox requires its atomic original inbox'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER signature_webhook_outbox_guard BEFORE INSERT OR UPDATE OR DELETE ON outbox_event FOR EACH ROW EXECUTE FUNCTION app_guard_signature_webhook_outbox();

CREATE FUNCTION app_native_signature_webhook_event_valid(event signature_event) RETURNS boolean LANGUAGE sql STABLE SET search_path=public,pg_temp AS $$
  SELECT coalesce(event.state IN('SENT','VIEWED','DECLINED','EXPIRED') AND event.signed_version_id IS NULL AND EXISTS(
    SELECT 1 FROM signature_provider_evidence e JOIN signature_provider_attempt a ON a.organization_id=e.organization_id AND a.id=e.attempt_id
      JOIN signature_provider_intent i ON i.organization_id=a.organization_id AND i.id=a.intent_id
      JOIN signature_provider_webhook w ON w.organization_id=e.organization_id AND w.id=e.webhook_id
    WHERE e.organization_id=event.organization_id AND e.id=event.provider_evidence_id AND e.signature_id=event.signature_id AND e.kind=event.state
      AND e.phase='PREPARE' AND a.phase='PREPARE' AND i.phase='PREPARE' AND i.policy_snapshot->>'protocol'='ALVILLAS_SIGNATURE_PREPARATION_V1'
      AND w.signature_id=event.signature_id AND w.preparation_attempt_id=a.id AND w.provider_scope_hash=e.provider_scope_hash AND w.provider_request_id=e.provider_request_id
      AND event.provider_identity_hash=e.provider_scope_hash AND event.provider_request_id=e.provider_request_id
      AND event.provider_event_id='native-webhook:'||w.provider_event_id||':'||e.kind AND event.evidence_hash=e.payload_sha256 AND event.evidence_cipher=e.payload_cipher
      AND event.occurred_at=w.occurred_at AND event.observed_at=e.observed_at
      AND EXISTS(SELECT 1 FROM signature_provider_evidence creation WHERE creation.organization_id=e.organization_id AND creation.attempt_id=a.id AND creation.webhook_id IS NULL AND creation.provider_request_id=e.provider_request_id)
      AND EXISTS(SELECT 1 FROM audit_log audit WHERE audit.organization_id=event.organization_id AND audit.actor_id IS NULL AND audit.resource_type='signature' AND audit.resource_id=event.signature_id
        AND audit.action='documents.signature.'||lower(event.state) AND audit.occurred_at=event.observed_at
        AND audit.xmin=(SELECT actual_event.xmin FROM signature_event actual_event WHERE actual_event.organization_id=event.organization_id AND actual_event.id=event.id)
        AND audit.after=jsonb_build_object('signatureId',event.signature_id,'intentId',i.id,'attemptId',a.id,'evidenceId',e.id,'signatureEventId',event.id))
  ),false)
$$;

CREATE FUNCTION app_guard_signature_webhook_evidence() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE inbox signature_provider_webhook%ROWTYPE; attempt signature_provider_attempt%ROWTYPE; history signature_event%ROWTYPE;
BEGIN
  IF NEW.webhook_id IS NULL THEN RETURN NULL; END IF;
  SELECT * INTO inbox FROM signature_provider_webhook WHERE organization_id=NEW.organization_id AND id=NEW.webhook_id;
  SELECT * INTO attempt FROM signature_provider_attempt WHERE organization_id=NEW.organization_id AND id=NEW.attempt_id;
  IF NOT coalesce(inbox.id IS NOT NULL AND attempt.id=inbox.preparation_attempt_id AND attempt.phase='PREPARE' AND NEW.phase='PREPARE'
    AND NEW.signature_id=inbox.signature_id AND NEW.provider_scope_hash=inbox.provider_scope_hash AND NEW.provider_request_id=inbox.provider_request_id AND NEW.observed_at>=inbox.received_at
    AND ((NEW.kind='SENT' AND inbox.event_type='DOCUMENT_SENT') OR(NEW.kind='VIEWED' AND inbox.event_type='DOCUMENT_OPENED') OR(NEW.kind='DECLINED' AND inbox.event_type='DOCUMENT_REJECTED') OR(NEW.kind='EXPIRED' AND inbox.event_type='RECIPIENT_EXPIRED') OR NEW.kind IN('OBSERVED','COMPLETION','UNCERTAIN'))
    AND EXISTS(SELECT 1 FROM signature_provider_evidence creation WHERE creation.organization_id=NEW.organization_id AND creation.attempt_id=attempt.id AND creation.webhook_id IS NULL AND creation.provider_request_id=NEW.provider_request_id),false)
  THEN RAISE EXCEPTION 'native webhook evidence requires its exact acknowledged original request and authenticated retained inbox'; END IF;
  SELECT * INTO history FROM signature_event WHERE organization_id=NEW.organization_id AND provider_evidence_id=NEW.id;
  IF NEW.kind IN('SENT','VIEWED','DECLINED','EXPIRED') THEN
    IF history.id IS NULL OR NOT app_native_signature_webhook_event_valid(history) OR NOT EXISTS(SELECT 1 FROM signature_event actual_event WHERE actual_event.organization_id=NEW.organization_id AND actual_event.id=history.id AND actual_event.xmin::text=pg_current_xact_id()::xid::text)
    THEN RAISE EXCEPTION 'native webhook transition requires its atomic audited original history'; END IF;
  ELSIF history.id IS NOT NULL THEN RAISE EXCEPTION 'provider observation cannot invent a native signature transition or signed archive'; END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER signature_webhook_evidence_guard AFTER INSERT ON signature_provider_evidence DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app_guard_signature_webhook_evidence();

CREATE OR REPLACE FUNCTION app_guard_signature_distribution_evidence() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE original signature_provider_intent%ROWTYPE; attempt signature_provider_attempt%ROWTYPE; history signature_event%ROWTYPE;
BEGIN
  IF NEW.webhook_id IS NOT NULL THEN RETURN NULL; END IF;
  IF NEW.kind<>'SENT' THEN RETURN NULL; END IF;
  SELECT * INTO attempt FROM signature_provider_attempt WHERE organization_id=NEW.organization_id AND id=NEW.attempt_id;
  SELECT * INTO original FROM signature_provider_intent WHERE organization_id=NEW.organization_id AND id=attempt.intent_id;
  SELECT * INTO history FROM signature_event WHERE organization_id=NEW.organization_id AND provider_evidence_id=NEW.id;
  IF NOT coalesce(NEW.phase='SEND' AND original.phase='SEND' AND original.policy_snapshot->>'protocol'='ALVILLAS_SIGNATURE_DISTRIBUTION_V1'
    AND NEW.provider_request_id=original.policy_snapshot->'preparation'->>'providerRequestId'
    AND NEW.provider_state IN('PENDING','COMPLETED') AND history.id IS NOT NULL
    AND EXISTS(SELECT 1 FROM signature_event actual_event WHERE actual_event.organization_id=NEW.organization_id AND actual_event.id=history.id AND actual_event.xmin::text=pg_current_xact_id()::xid::text)
    AND app_native_signature_distribution_event_valid(history),false)
  THEN RAISE EXCEPTION 'native sent evidence requires its prepared provider identity and atomic audited signature history'; END IF;
  RETURN NULL;
END $$;

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
    OR EXISTS(SELECT 1 FROM signature_event e WHERE e.organization_id=original.organization_id AND e.signature_id=original.id AND e.state<>'DRAFT' AND NOT(app_native_signature_distribution_event_valid(e) OR app_native_signature_webhook_event_valid(e)))
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
