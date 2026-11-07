BEGIN;

-- CreateTable
CREATE TABLE "signature_provider_scope" (
    "scope_hash" CHAR(64) NOT NULL,
    "organization_id" UUID NOT NULL,
    "origin" TEXT NOT NULL,
    "team_id" INTEGER NOT NULL,
    "policy_id" UUID NOT NULL,
    "policy_version" INTEGER NOT NULL,
    "claimed_by" UUID NOT NULL,
    "claimed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "signature_provider_scope_pkey" PRIMARY KEY ("scope_hash")
);

-- CreateTable
CREATE TABLE "signature_provider_intent" (
    "id" UUID NOT NULL DEFAULT app_uuid_v7(),
    "organization_id" UUID NOT NULL,
    "signature_id" UUID NOT NULL,
    "phase" TEXT NOT NULL,
    "command_key" UUID NOT NULL,
    "command_hash" CHAR(64) NOT NULL,
    "canonical_request" TEXT NOT NULL,
    "input" JSONB NOT NULL,
    "policy_snapshot" JSONB NOT NULL,
    "authorization_cap" JSONB NOT NULL,
    "source_fingerprint" CHAR(64) NOT NULL,
    "provider_scope_hash" CHAR(64) NOT NULL,
    "reason" TEXT NOT NULL,
    "requested_by" UUID NOT NULL,
    "requested_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "signature_provider_intent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "signature_provider_attempt" (
    "id" UUID NOT NULL DEFAULT app_uuid_v7(),
    "organization_id" UUID NOT NULL,
    "intent_id" UUID NOT NULL,
    "signature_id" UUID NOT NULL,
    "phase" TEXT NOT NULL,
    "started_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "signature_provider_attempt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "signature_provider_evidence" (
    "id" UUID NOT NULL DEFAULT app_uuid_v7(),
    "organization_id" UUID NOT NULL,
    "attempt_id" UUID NOT NULL,
    "signature_id" UUID NOT NULL,
    "phase" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "provider_scope_hash" CHAR(64) NOT NULL,
    "provider_request_id" TEXT,
    "provider_state" TEXT,
    "original_pdf_sha256" CHAR(64) NOT NULL,
    "contract_hash" CHAR(64) NOT NULL,
    "observation_hash" CHAR(64) NOT NULL,
    "payload_sha256" CHAR(64) NOT NULL,
    "payload_byte_size" INTEGER NOT NULL,
    "payload_cipher" BYTEA NOT NULL,
    "observed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "signature_provider_evidence_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "signature_provider_scope_org_hash_unique" ON "signature_provider_scope"("organization_id", "scope_hash");

-- CreateIndex
CREATE INDEX "signature_provider_intent_nonce_idx" ON "signature_provider_intent"("organization_id", "command_key");

-- CreateIndex
CREATE INDEX "signature_provider_intent_scope_idx" ON "signature_provider_intent"("provider_scope_hash", "organization_id");

-- CreateIndex
CREATE UNIQUE INDEX "signature_provider_intent_org_id_unique" ON "signature_provider_intent"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "signature_provider_intent_phase_unique" ON "signature_provider_intent"("organization_id", "id", "signature_id", "phase");

-- CreateIndex
CREATE UNIQUE INDEX "signature_provider_intent_command_unique" ON "signature_provider_intent"("organization_id", "requested_by", "command_key");

-- CreateIndex
CREATE UNIQUE INDEX "signature_provider_attempt_org_id_unique" ON "signature_provider_attempt"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "signature_provider_attempt_phase_unique" ON "signature_provider_attempt"("organization_id", "id", "signature_id", "phase");

-- CreateIndex
CREATE UNIQUE INDEX "signature_provider_attempt_intent_unique" ON "signature_provider_attempt"("organization_id", "intent_id", "signature_id", "phase");

-- CreateIndex
CREATE UNIQUE INDEX "signature_provider_attempt_effect_unique" ON "signature_provider_attempt"("organization_id", "signature_id", "phase");

-- CreateIndex
CREATE INDEX "signature_provider_evidence_history_idx" ON "signature_provider_evidence"("organization_id", "signature_id", "observed_at", "id");

-- CreateIndex
CREATE UNIQUE INDEX "signature_provider_evidence_org_id_unique" ON "signature_provider_evidence"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "signature_provider_evidence_observation_unique" ON "signature_provider_evidence"("organization_id", "attempt_id", "observation_hash");

-- AddForeignKey
ALTER TABLE "signature_provider_scope" ADD CONSTRAINT "signature_provider_scope_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "signature_provider_scope" ADD CONSTRAINT "signature_provider_scope_organization_id_claimed_by_fkey" FOREIGN KEY ("organization_id", "claimed_by") REFERENCES "user_account"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "signature_provider_scope" ADD CONSTRAINT "signature_provider_scope_organization_id_policy_id_fkey" FOREIGN KEY ("organization_id", "policy_id") REFERENCES "config_rule"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "signature_provider_intent" ADD CONSTRAINT "signature_provider_intent_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "signature_provider_intent" ADD CONSTRAINT "signature_provider_intent_organization_id_signature_id_fkey" FOREIGN KEY ("organization_id", "signature_id") REFERENCES "signature"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "signature_provider_intent" ADD CONSTRAINT "signature_provider_intent_organization_id_provider_scope_h_fkey" FOREIGN KEY ("organization_id", "provider_scope_hash") REFERENCES "signature_provider_scope"("organization_id", "scope_hash") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "signature_provider_intent" ADD CONSTRAINT "signature_provider_intent_organization_id_requested_by_fkey" FOREIGN KEY ("organization_id", "requested_by") REFERENCES "user_account"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "signature_provider_attempt" ADD CONSTRAINT "signature_provider_attempt_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "signature_provider_attempt" ADD CONSTRAINT "signature_provider_attempt_organization_id_intent_id_signa_fkey" FOREIGN KEY ("organization_id", "intent_id", "signature_id", "phase") REFERENCES "signature_provider_intent"("organization_id", "id", "signature_id", "phase") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "signature_provider_evidence" ADD CONSTRAINT "signature_provider_evidence_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "signature_provider_evidence" ADD CONSTRAINT "signature_provider_evidence_organization_id_attempt_id_sig_fkey" FOREIGN KEY ("organization_id", "attempt_id", "signature_id", "phase") REFERENCES "signature_provider_attempt"("organization_id", "id", "signature_id", "phase") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- Native account ownership must remain exclusive even when forced RLS hides another tenant.
ALTER TABLE signature_provider_scope ADD CONSTRAINT signature_provider_scope_shape CHECK (
  scope_hash ~ '^[a-f0-9]{64}$' AND length(origin) BETWEEN 1 AND 2048 AND team_id>0 AND policy_version>0);
ALTER TABLE signature_provider_intent ADD CONSTRAINT signature_provider_intent_shape CHECK (
  phase='PREPARE' AND command_hash ~ '^[a-f0-9]{64}$' AND source_fingerprint ~ '^[a-f0-9]{64}$'
  AND provider_scope_hash ~ '^[a-f0-9]{64}$' AND length(reason) BETWEEN 8 AND 1000
  AND octet_length(canonical_request) BETWEEN 1 AND 1064960
  AND jsonb_typeof(input)='object' AND jsonb_typeof(policy_snapshot)='object' AND jsonb_typeof(authorization_cap)='object');
ALTER TABLE signature_provider_attempt ADD CONSTRAINT signature_provider_attempt_shape CHECK(phase='PREPARE');
ALTER TABLE signature_provider_evidence ADD CONSTRAINT signature_provider_evidence_shape CHECK (coalesce(
  phase='PREPARE' AND kind IN('PREPARED','UNCERTAIN') AND provider_scope_hash ~ '^[a-f0-9]{64}$'
  AND original_pdf_sha256 ~ '^[a-f0-9]{64}$' AND contract_hash ~ '^[a-f0-9]{64}$' AND observation_hash ~ '^[a-f0-9]{64}$' AND payload_sha256 ~ '^[a-f0-9]{64}$'
  AND payload_byte_size BETWEEN 1 AND 4194304 AND octet_length(payload_cipher)>payload_byte_size AND octet_length(payload_cipher)<=payload_byte_size+256
  AND (provider_request_id IS NULL OR provider_request_id ~ '^[A-Za-z0-9_-]{1,255}$')
  AND ((kind='PREPARED' AND provider_request_id IS NOT NULL AND provider_state='DRAFT') OR (kind='UNCERTAIN' AND provider_state IS NULL)),false));
CREATE UNIQUE INDEX signature_provider_prepared_native_unique ON signature_provider_evidence(organization_id,signature_id,phase) WHERE kind='PREPARED';
CREATE UNIQUE INDEX signature_provider_prepared_external_unique ON signature_provider_evidence(provider_scope_hash,provider_request_id) WHERE kind='PREPARED';

DO $$ DECLARE name text;
BEGIN
  FOREACH name IN ARRAY ARRAY['signature_provider_scope','signature_provider_intent','signature_provider_attempt','signature_provider_evidence'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',name);
    EXECUTE format('CREATE POLICY %I ON %I USING(organization_id=NULLIF(current_setting(''app.current_organization_id'',true),'''')::uuid) WITH CHECK(organization_id=NULLIF(current_setting(''app.current_organization_id'',true),'''')::uuid)',name||'_tenant_isolation',name);
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION app_document_append_only()',name||'_immutable',name);
  END LOOP;
END $$;

CREATE OR REPLACE FUNCTION app_guard_document_signature_nonce() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE actor_uuid uuid;
BEGIN
  IF TG_TABLE_NAME IN('signature','signature_provider_intent') THEN actor_uuid:=NEW.requested_by; ELSE actor_uuid:=NEW.created_by; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.organization_id::text||':documents:nonce:'||actor_uuid::text||':'||NEW.command_key::text,0));
  IF TG_TABLE_NAME IN('signature','signature_provider_intent') AND (
    EXISTS(SELECT 1 FROM document_admission WHERE organization_id=NEW.organization_id AND created_by=actor_uuid AND command_key=NEW.command_key)
    OR EXISTS(SELECT 1 FROM document_instance WHERE organization_id=NEW.organization_id AND created_by=actor_uuid AND command_key=NEW.command_key))
  THEN RAISE EXCEPTION 'document command nonce belongs to another protocol'; END IF;
  IF TG_TABLE_NAME<>'signature' AND EXISTS(SELECT 1 FROM signature WHERE organization_id=NEW.organization_id AND requested_by=actor_uuid AND command_key=NEW.command_key)
    OR TG_TABLE_NAME<>'signature_provider_intent' AND EXISTS(SELECT 1 FROM signature_provider_intent WHERE organization_id=NEW.organization_id AND requested_by=actor_uuid AND command_key=NEW.command_key)
  THEN RAISE EXCEPTION 'document command nonce belongs to another protocol'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER signature_provider_intent_nonce_guard BEFORE INSERT ON signature_provider_intent FOR EACH ROW EXECUTE FUNCTION app_guard_document_signature_nonce();

CREATE FUNCTION app_signature_provider_scope_hash(origin_text text,team_number integer) RETURNS text LANGUAGE SQL IMMUTABLE SET search_path=public,pg_temp AS $$
  SELECT encode(digest('["DOCUMENSO",'||to_json(origin_text)::text||','||team_number::text||']','sha256'),'hex');
$$;

CREATE FUNCTION app_guard_signature_provider_scope() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE rule config_rule%ROWTYPE;
BEGIN
  SELECT * INTO rule FROM config_rule WHERE organization_id=NEW.organization_id AND id=NEW.policy_id;
  IF NOT coalesce(rule.id IS NOT NULL AND rule.key='documents.signatures' AND rule.version=NEW.policy_version
    AND rule.value->>'source'='NATIVE_DOCUMENT_SIGNATURES' AND rule.value->>'provider'='DOCUMENSO' AND rule.value->'enabled'='true'::jsonb
    AND NEW.origin=regexp_replace(rule.value->'account'->>'origin','/$','') AND NEW.team_id::text=rule.value->'account'->>'teamId'
    AND NEW.scope_hash=app_signature_provider_scope_hash(NEW.origin,NEW.team_id),false)
  THEN RAISE EXCEPTION 'native signature scope requires its actual configured organization account'; END IF;
  IF NOT EXISTS(SELECT 1 FROM signature_provider_intent i WHERE i.organization_id=NEW.organization_id AND i.provider_scope_hash=NEW.scope_hash
    AND i.requested_by=NEW.claimed_by AND i.requested_at=NEW.claimed_at AND i.xmin::text=pg_current_xact_id()::xid::text)
    OR NOT EXISTS(SELECT 1 FROM audit_log a WHERE a.organization_id=NEW.organization_id AND a.actor_id=NEW.claimed_by AND a.resource_type='config_rule' AND a.resource_id=NEW.policy_id
      AND a.action='documents.signature.provider_scope_claimed' AND a.occurred_at=NEW.claimed_at AND a.after=jsonb_build_object('providerScopeHash',NEW.scope_hash,'policyId',NEW.policy_id)
      AND a.xmin::text=pg_current_xact_id()::xid::text)
  THEN RAISE EXCEPTION 'native signature account scope requires atomic intent and canonical audit'; END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER signature_provider_scope_guard AFTER INSERT ON signature_provider_scope DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app_guard_signature_provider_scope();

CREATE FUNCTION app_guard_signature_provider_intent() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE original signature%ROWTYPE; rule config_rule%ROWTYPE; root document%ROWTYPE; snapshot jsonb; layout jsonb; native jsonb; field jsonb; item jsonb;
  scope signature_provider_scope%ROWTYPE; ordinal bigint; recipients integer;
BEGIN
  snapshot:=NEW.policy_snapshot;
  SELECT * INTO original FROM signature WHERE organization_id=NEW.organization_id AND id=NEW.signature_id;
  SELECT * INTO rule FROM config_rule WHERE organization_id=NEW.organization_id AND id=(snapshot->'providerPolicy'->>'id')::uuid;
  SELECT d.* INTO root FROM document d JOIN document_instance i ON i.organization_id=d.organization_id AND i.document_id=d.id WHERE i.organization_id=NEW.organization_id AND i.id=original.instance_id;
  SELECT * INTO scope FROM signature_provider_scope WHERE organization_id=NEW.organization_id AND scope_hash=NEW.provider_scope_hash;
  IF NOT coalesce(original.policy_snapshot->>'protocol'='ALVILLAS_NATIVE_SIGNATURE_REQUEST_V1' AND root.id IS NOT NULL AND root.archived_at IS NULL
    AND snapshot->>'protocol'='ALVILLAS_SIGNATURE_PREPARATION_V1' AND snapshot->>'schemaVersion'='1' AND snapshot->'command'=NEW.input
    AND snapshot->>'commandHash'=NEW.command_hash AND snapshot->>'signatureCommandHash'=original.command_hash
    AND snapshot->>'contextFingerprint' ~ '^[a-f0-9]{64}$' AND snapshot->>'contractHash' ~ '^[a-f0-9]{64}$'
    AND NEW.source_fingerprint=original.source_fingerprint AND snapshot->'document'=original.policy_snapshot->'document'
    AND NEW.input->>'signatureId'=NEW.signature_id::text AND NEW.input->>'idempotencyKey'=NEW.command_key::text AND NEW.input->>'reason'=NEW.reason
    AND NEW.input->>'reviewFingerprint' ~ '^[a-f0-9]{64}$'
    AND NEW.canonical_request::jsonb=jsonb_build_object('organizationId',NEW.organization_id,'actorId',NEW.requested_by,'input',NEW.input)
    AND encode(digest(NEW.canonical_request,'sha256'),'hex')=NEW.command_hash
    AND NEW.authorization_cap->>'schemaVersion'='1' AND NEW.authorization_cap->>'organizationId'=NEW.organization_id::text AND NEW.authorization_cap->>'userAccountId'=NEW.requested_by::text
    AND NEW.authorization_cap->'permissions' ?& ARRAY['signature:view','signature:create','document:export','document_instance:export']
    AND scope.scope_hash IS NOT NULL AND snapshot->>'providerScopeHash'=NEW.provider_scope_hash
    AND rule.id IS NOT NULL AND rule.key='documents.signatures' AND rule.version::text=snapshot->'providerPolicy'->>'version'
    AND snapshot->'providerPolicy'->'originalValue'=rule.value
    AND snapshot->'providerPolicy'->'value'=jsonb_set(rule.value,'{account,origin}',to_jsonb(regexp_replace(rule.value->'account'->>'origin','/$','')))
    AND rule.value->'enabled'='true'::jsonb AND rule.value->>'provider'='DOCUMENSO' AND rule.value->>'source'='NATIVE_DOCUMENT_SIGNATURES'
    AND scope.origin=snapshot->'providerPolicy'->'value'->'account'->>'origin' AND scope.team_id::text=snapshot->'providerPolicy'->'value'->'account'->>'teamId'
    AND jsonb_typeof(NEW.input->'recipients')='array' AND jsonb_typeof(snapshot->'recipients')='array',false)
  THEN RAISE EXCEPTION 'native preparation requires its original signature, actor, archived PDF and actual policy'; END IF;
  recipients:=jsonb_array_length(NEW.input->'recipients');
  IF recipients NOT BETWEEN 1 AND 100 OR recipients<>(SELECT count(*) FROM signature_recipient WHERE organization_id=NEW.organization_id AND signature_id=NEW.signature_id)
    OR recipients<>jsonb_array_length(snapshot->'recipients') OR (SELECT count(DISTINCT value->>'recipientId') FROM jsonb_array_elements(NEW.input->'recipients'))<>recipients
    OR EXISTS(SELECT 1 FROM jsonb_object_keys(NEW.input) k WHERE k NOT IN('signatureId','recipients','idempotencyKey','reviewFingerprint','reason'))
  THEN RAISE EXCEPTION 'native preparation requires every original native recipient and bounded command'; END IF;
  FOR layout,ordinal IN SELECT value, ordinality FROM jsonb_array_elements(NEW.input->'recipients') WITH ORDINALITY LOOP
    item:=snapshot->'recipients'->(ordinal::integer-1);
    SELECT source_snapshot->'identity' INTO native FROM signature_recipient WHERE organization_id=NEW.organization_id AND signature_id=NEW.signature_id AND id=(layout->>'recipientId')::uuid;
    IF NOT coalesce(native IS NOT NULL AND item->>'id'=layout->>'recipientId' AND item->>'fingerprint'=native->>'fingerprint'
      AND item->>'identityHash'=(SELECT identity_hash FROM signature_recipient WHERE organization_id=NEW.organization_id AND id=(layout->>'recipientId')::uuid)
      AND layout->>'role' IN('SIGNER','APPROVER','VIEWER','CC','ASSISTANT') AND jsonb_typeof(layout->'fields')='array'
      AND jsonb_array_length(layout->'fields')<=200 AND jsonb_typeof(layout->'signingOrder')='number' AND (layout->>'signingOrder')::numeric>=0
      AND trunc((layout->>'signingOrder')::numeric)=(layout->>'signingOrder')::numeric,false)
      OR EXISTS(SELECT 1 FROM jsonb_object_keys(layout) k WHERE k NOT IN('recipientId','role','signingOrder','fields'))
    THEN RAISE EXCEPTION 'native preparation layout cannot substitute an actual captured recipient'; END IF;
    IF layout->>'role'='SIGNER' AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(layout->'fields') f WHERE f->>'type'='SIGNATURE')
    THEN RAISE EXCEPTION 'native signer requires an explicit signature field'; END IF;
    FOR field IN SELECT value FROM jsonb_array_elements(layout->'fields') LOOP
      IF NOT coalesce(field->>'type' IN('SIGNATURE','INITIALS','NAME','EMAIL','DATE') AND jsonb_typeof(field->'page')='number' AND (field->>'page')::numeric>=1 AND trunc((field->>'page')::numeric)=(field->>'page')::numeric
        AND jsonb_typeof(field->'positionX')='number' AND jsonb_typeof(field->'positionY')='number' AND jsonb_typeof(field->'width')='number' AND jsonb_typeof(field->'height')='number'
        AND (field->>'positionX')::numeric>=0 AND (field->>'positionY')::numeric>=0 AND (field->>'width')::numeric>0 AND (field->>'height')::numeric>0
        AND (field->>'positionX')::numeric+(field->>'width')::numeric<=100 AND (field->>'positionY')::numeric+(field->>'height')::numeric<=100,false)
        OR EXISTS(SELECT 1 FROM jsonb_object_keys(field) k WHERE k NOT IN('type','page','positionX','positionY','width','height'))
      THEN RAISE EXCEPTION 'native preparation requires explicit bounded PDF field geometry'; END IF;
    END LOOP;
  END LOOP;
  IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(NEW.input->'recipients') r WHERE r->>'role'='SIGNER')
    OR (SELECT coalesce(sum(jsonb_array_length(r->'fields')),0) FROM jsonb_array_elements(NEW.input->'recipients') r)>10000
  THEN RAISE EXCEPTION 'native preparation requires its actual signing contract'; END IF;
  IF snapshot->'providerPolicy'->'value'->'signing'->>'order'='SEQUENTIAL' AND (
    EXISTS(SELECT 1 FROM jsonb_array_elements(NEW.input->'recipients') r WHERE r->>'role' IN('SIGNER','APPROVER') AND (r->>'signingOrder')::numeric<1)
    OR (SELECT count(*) FROM jsonb_array_elements(NEW.input->'recipients') r WHERE r->>'role' IN('SIGNER','APPROVER'))
      <>(SELECT count(DISTINCT r->>'signingOrder') FROM jsonb_array_elements(NEW.input->'recipients') r WHERE r->>'role' IN('SIGNER','APPROVER')))
  THEN RAISE EXCEPTION 'sequential native recipients require explicit distinct signing positions'; END IF;
  IF NOT EXISTS(SELECT 1 FROM audit_log a WHERE a.organization_id=NEW.organization_id AND a.actor_id=NEW.requested_by AND a.resource_type='signature' AND a.resource_id=NEW.id
    AND a.action='documents.signature.preparation_requested' AND a.occurred_at=NEW.requested_at
    AND a.after=jsonb_build_object('signatureId',NEW.signature_id,'intentId',NEW.id,'commandHash',NEW.command_hash,'contractHash',snapshot->>'contractHash')
    AND a.xmin::text=pg_current_xact_id()::xid::text)
    OR NOT EXISTS(SELECT 1 FROM outbox_event e WHERE e.organization_id=NEW.organization_id AND e.type='documents.signature.prepare_requested' AND e.payload=jsonb_build_object('intentId',NEW.id)
      AND e.idempotency_key='document-signature-prepare:'||NEW.requested_by::text||':'||NEW.command_key::text AND e.occurred_at=NEW.requested_at AND e.xmin::text=pg_current_xact_id()::xid::text)
  THEN RAISE EXCEPTION 'native preparation requires atomic private intent audit and reference-only outbox'; END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER signature_provider_intent_guard AFTER INSERT ON signature_provider_intent DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app_guard_signature_provider_intent();

CREATE FUNCTION app_guard_signature_provider_attempt() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE original signature_provider_intent%ROWTYPE;
BEGIN
  SELECT * INTO original FROM signature_provider_intent WHERE organization_id=NEW.organization_id AND id=NEW.intent_id;
  IF original.id IS NULL OR original.signature_id<>NEW.signature_id OR original.phase<>NEW.phase OR NEW.started_at<original.requested_at
    OR NOT EXISTS(SELECT 1 FROM audit_log a WHERE a.organization_id=NEW.organization_id AND a.actor_id IS NULL AND a.resource_type='signature' AND a.resource_id=NEW.id
      AND a.action='documents.signature.preparation_started' AND a.occurred_at=NEW.started_at
      AND a.after=jsonb_build_object('signatureId',NEW.signature_id,'intentId',NEW.intent_id,'attemptId',NEW.id,'commandHash',original.command_hash)
      AND a.xmin::text=pg_current_xact_id()::xid::text)
  THEN RAISE EXCEPTION 'native provider attempt requires its original authorized intent and atomic system audit'; END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER signature_provider_attempt_guard AFTER INSERT ON signature_provider_attempt DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app_guard_signature_provider_attempt();

CREATE FUNCTION app_guard_signature_provider_evidence() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE attempt signature_provider_attempt%ROWTYPE; original signature_provider_intent%ROWTYPE; boundary integer;
BEGIN
  SELECT * INTO attempt FROM signature_provider_attempt WHERE organization_id=NEW.organization_id AND id=NEW.attempt_id;
  SELECT * INTO original FROM signature_provider_intent WHERE organization_id=NEW.organization_id AND id=attempt.intent_id;
  boundary:=position(decode('0a','hex') in NEW.payload_cipher);
  IF NOT coalesce(attempt.id IS NOT NULL AND original.id IS NOT NULL AND NEW.signature_id=attempt.signature_id AND NEW.phase=attempt.phase
    AND NEW.provider_scope_hash=original.provider_scope_hash AND NEW.contract_hash=original.policy_snapshot->>'contractHash'
    AND NEW.original_pdf_sha256=original.policy_snapshot->'document'->>'sha256' AND NEW.observed_at>=attempt.started_at
    AND boundary BETWEEN 1 AND 256 AND octet_length(NEW.payload_cipher)-boundary=NEW.payload_byte_size
    AND convert_from(substring(NEW.payload_cipher FROM 1 FOR greatest(boundary-1,0)),'UTF8') ~ '^alvillas-binary-v1:[^:]{1,180}:[A-Za-z0-9_-]{16}:[A-Za-z0-9_-]{22}$',false)
    OR NOT EXISTS(SELECT 1 FROM audit_log a WHERE a.organization_id=NEW.organization_id AND a.actor_id IS NULL AND a.resource_type='signature' AND a.resource_id=NEW.id
      AND a.action='documents.signature.provider_observed' AND a.occurred_at=NEW.observed_at
      AND a.after=jsonb_build_object('signatureId',NEW.signature_id,'intentId',original.id,'attemptId',NEW.attempt_id,'evidenceId',NEW.id,'kind',NEW.kind,'payloadSha256',NEW.payload_sha256,'observationHash',NEW.observation_hash)
      AND a.xmin::text=pg_current_xact_id()::xid::text)
  THEN RAISE EXCEPTION 'native provider evidence requires its original attempt, encrypted payload and atomic system audit'; END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER signature_provider_evidence_guard AFTER INSERT ON signature_provider_evidence DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app_guard_signature_provider_evidence();

CREATE FUNCTION app_guard_signature_preparation_outbox() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    IF OLD.type='documents.signature.prepare_requested' OR OLD.idempotency_key LIKE 'document-signature-prepare:%'
    THEN RAISE EXCEPTION 'native signature preparation references are append-only'; END IF;
    RETURN OLD;
  END IF;
  IF TG_OP='UPDATE' THEN
    IF (OLD.type='documents.signature.prepare_requested' OR OLD.idempotency_key LIKE 'document-signature-prepare:%')
      AND (NEW.organization_id,NEW.id,NEW.type,NEW.payload,NEW.idempotency_key,NEW.occurred_at)
        IS DISTINCT FROM (OLD.organization_id,OLD.id,OLD.type,OLD.payload,OLD.idempotency_key,OLD.occurred_at)
    THEN RAISE EXCEPTION 'native signature preparation reference identity is immutable'; END IF;
  END IF;
  IF NEW.type='documents.signature.prepare_requested' OR NEW.idempotency_key LIKE 'document-signature-prepare:%' THEN
    IF NOT EXISTS(SELECT 1 FROM signature_provider_intent i WHERE i.organization_id=NEW.organization_id AND i.phase='PREPARE'
      AND NEW.type='documents.signature.prepare_requested' AND NEW.payload=jsonb_build_object('intentId',i.id)
      AND NEW.idempotency_key='document-signature-prepare:'||i.requested_by::text||':'||i.command_key::text AND NEW.occurred_at=i.requested_at)
    THEN RAISE EXCEPTION 'native signature preparation requires its exact original outbox reference'; END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER signature_preparation_outbox_guard BEFORE INSERT OR UPDATE OR DELETE ON outbox_event FOR EACH ROW EXECUTE FUNCTION app_guard_signature_preparation_outbox();

COMMIT;
