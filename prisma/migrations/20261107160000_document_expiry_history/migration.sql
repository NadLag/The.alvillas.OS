-- CreateTable
CREATE TABLE "document_expiry_revision" (
    "id" UUID NOT NULL DEFAULT app_uuid_v7(),
    "organization_id" UUID NOT NULL,
    "version_id" UUID NOT NULL,
    "previous_id" UUID,
    "number" INTEGER NOT NULL,
    "expires_on" DATE,
    "command_key" UUID NOT NULL,
    "command_hash" CHAR(64) NOT NULL,
    "source_fingerprint" CHAR(64) NOT NULL,
    "authorization_cap" JSONB NOT NULL,
    "source_snapshot" JSONB NOT NULL,
    "policy_snapshot" JSONB NOT NULL,
    "input" JSONB NOT NULL,
    "reason" TEXT NOT NULL,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "document_expiry_revision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "document_expiry_reminder" (
    "id" UUID NOT NULL DEFAULT app_uuid_v7(),
    "organization_id" UUID NOT NULL,
    "revision_id" UUID NOT NULL,
    "principal_id" UUID NOT NULL,
    "idempotency_key" VARCHAR(400) NOT NULL,
    "command_hash" CHAR(64) NOT NULL,
    "source_fingerprint" CHAR(64) NOT NULL,
    "stage_key" TEXT NOT NULL,
    "occurred_on" DATE NOT NULL,
    "policy_snapshot" JSONB NOT NULL,
    "routing_snapshot" JSONB NOT NULL,
    "source_snapshot" JSONB NOT NULL,
    "authorization_snapshots" JSONB NOT NULL,
    "recipient_ids" UUID[],
    "outbox_event_ids" UUID[],
    "observed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "document_expiry_reminder_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "document_expiry_revision_due_idx" ON "document_expiry_revision"("organization_id", "expires_on", "id");

-- CreateIndex
CREATE INDEX "document_expiry_revision_nonce_owner_idx" ON "document_expiry_revision"("organization_id", "command_key");

-- CreateIndex
CREATE UNIQUE INDEX "document_expiry_revision_org_id_unique" ON "document_expiry_revision"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "document_expiry_revision_number_unique" ON "document_expiry_revision"("organization_id", "version_id", "number");

-- CreateIndex
CREATE UNIQUE INDEX "document_expiry_revision_successor_unique" ON "document_expiry_revision"("organization_id", "previous_id");

-- CreateIndex
CREATE UNIQUE INDEX "document_expiry_revision_command_unique" ON "document_expiry_revision"("organization_id", "created_by", "command_key");

-- CreateIndex
CREATE INDEX "document_expiry_reminder_revision_idx" ON "document_expiry_reminder"("organization_id", "revision_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "document_expiry_reminder_org_id_unique" ON "document_expiry_reminder"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "document_expiry_reminder_occurrence_unique" ON "document_expiry_reminder"("organization_id", "idempotency_key");

-- AddForeignKey
ALTER TABLE "document_expiry_revision" ADD CONSTRAINT "document_expiry_revision_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "document_expiry_revision" ADD CONSTRAINT "document_expiry_revision_organization_id_version_id_fkey" FOREIGN KEY ("organization_id", "version_id") REFERENCES "document_version"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "document_expiry_revision" ADD CONSTRAINT "document_expiry_revision_organization_id_previous_id_fkey" FOREIGN KEY ("organization_id", "previous_id") REFERENCES "document_expiry_revision"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "document_expiry_revision" ADD CONSTRAINT "document_expiry_revision_organization_id_created_by_fkey" FOREIGN KEY ("organization_id", "created_by") REFERENCES "user_account"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "document_expiry_reminder" ADD CONSTRAINT "document_expiry_reminder_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "document_expiry_reminder" ADD CONSTRAINT "document_expiry_reminder_organization_id_revision_id_fkey" FOREIGN KEY ("organization_id", "revision_id") REFERENCES "document_expiry_revision"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "document_expiry_reminder" ADD CONSTRAINT "document_expiry_reminder_organization_id_principal_id_fkey" FOREIGN KEY ("organization_id", "principal_id") REFERENCES "user_account"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;


-- Tenant and history protection are explicit so static and native gates agree.
ALTER TABLE document_expiry_revision ENABLE ROW LEVEL SECURITY;
ALTER TABLE document_expiry_revision FORCE ROW LEVEL SECURITY;
CREATE POLICY document_expiry_revision_tenant_isolation ON document_expiry_revision
  USING(organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid)
  WITH CHECK(organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid);
ALTER TABLE document_expiry_reminder ENABLE ROW LEVEL SECURITY;
ALTER TABLE document_expiry_reminder FORCE ROW LEVEL SECURITY;
CREATE POLICY document_expiry_reminder_tenant_isolation ON document_expiry_reminder
  USING(organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid)
  WITH CHECK(organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid);
CREATE TRIGGER document_expiry_revision_immutable BEFORE UPDATE OR DELETE ON document_expiry_revision
  FOR EACH ROW EXECUTE FUNCTION app_document_append_only();
CREATE TRIGGER document_expiry_reminder_immutable BEFORE UPDATE OR DELETE ON document_expiry_reminder
  FOR EACH ROW EXECUTE FUNCTION app_document_append_only();

ALTER TABLE document_expiry_revision ADD CONSTRAINT document_expiry_revision_shape CHECK(coalesce(
  number>0 AND ((number=1 AND previous_id IS NULL) OR (number>1 AND previous_id IS NOT NULL))
  AND command_hash ~ '^[a-f0-9]{64}$' AND source_fingerprint ~ '^[a-f0-9]{64}$'
  AND length(reason) BETWEEN 8 AND 1000 AND created_at<=clock_timestamp()
  AND jsonb_typeof(authorization_cap)='object' AND jsonb_typeof(source_snapshot)='object'
  AND jsonb_typeof(policy_snapshot)='object' AND jsonb_typeof(input)='object',false));

CREATE FUNCTION app_guard_document_expiry_revision() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE original document_version%ROWTYPE; root document%ROWTYPE; admission document_admission%ROWTYPE;
  prior document_expiry_revision%ROWTYPE; rule config_rule%ROWTYPE;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.organization_id::text||':documents:expiry:'||NEW.version_id::text,0));
  SELECT * INTO original FROM document_version WHERE organization_id=NEW.organization_id AND id=NEW.version_id;
  SELECT * INTO root FROM document WHERE organization_id=NEW.organization_id AND id=original.document_id;
  SELECT * INTO admission FROM document_admission WHERE organization_id=NEW.organization_id AND id=original.admission_id;
  SELECT * INTO prior FROM document_expiry_revision WHERE organization_id=NEW.organization_id AND version_id=NEW.version_id AND id<>NEW.id ORDER BY number DESC LIMIT 1;
  SELECT * INTO rule FROM config_rule WHERE organization_id=NEW.organization_id AND id=(NEW.policy_snapshot->>'id')::uuid;
  IF original.id IS NULL OR root.id IS NULL OR admission.id IS NULL OR root.kind NOT IN('FILE','INSTANCE') OR root.archived_at IS NOT NULL
    OR EXISTS(SELECT 1 FROM signature_signed_artifact WHERE organization_id=NEW.organization_id AND document_id=root.id)
    OR (prior.id IS NULL AND (NEW.previous_id IS NOT NULL OR NEW.number<>1))
    OR (prior.id IS NOT NULL AND (NEW.previous_id IS DISTINCT FROM prior.id OR NEW.number<>prior.number+1 OR NEW.created_at<prior.created_at))
    OR NEW.authorization_cap->>'organizationId' IS DISTINCT FROM NEW.organization_id::text
    OR NEW.authorization_cap->>'userAccountId' IS DISTINCT FROM NEW.created_by::text
    OR NEW.source_snapshot->>'documentId' IS DISTINCT FROM root.id::text
    OR NEW.source_snapshot->>'versionId' IS DISTINCT FROM original.id::text
    OR NEW.source_snapshot->>'versionSha256' IS DISTINCT FROM admission.sha256
    OR NOT coalesce(NEW.source_snapshot->'privacy' @> to_jsonb(root.privacy),false)
    OR NEW.input->>'protocol' IS DISTINCT FROM 'ALVILLAS_DOCUMENT_EXPIRY_V1'
    OR NEW.input->>'versionId' IS DISTINCT FROM NEW.version_id::text
    OR NEW.input->>'previousRevisionId' IS DISTINCT FROM NEW.previous_id::text
    OR NEW.input->>'expiresOn' IS DISTINCT FROM NEW.expires_on::text
    OR NEW.input->>'idempotencyKey' IS DISTINCT FROM NEW.command_key::text OR NEW.input->>'reason' IS DISTINCT FROM NEW.reason
    OR NOT coalesce(NEW.input->>'reviewFingerprint' ~ '^[a-f0-9]{64}$',false)
    OR rule.id IS NULL OR rule.key<>'documents.expiry_reminders'
    OR NEW.policy_snapshot IS DISTINCT FROM jsonb_build_object('id',rule.id,'version',rule.version,'value',rule.value)
    OR rule.value->>'source' IS DISTINCT FROM 'NATIVE_DOCUMENT_VERSIONS'
    OR rule.value->>'calendar' IS DISTINCT FROM 'ORGANIZATION_PROFILE'
    OR rule.value->>'principal' IS DISTINCT FROM 'CURRENT_CONFIGURATION_AUTHOR'
    OR rule.value->>'version_selection' IS DISTINCT FROM 'CURRENT_EFFECTIVE_VERSION'
    OR NOT coalesce(rule.value->'type_keys' ? root.type_key,false)
  THEN RAISE EXCEPTION 'document expiry requires its actual version, previous immutable revision and captured authority'; END IF;
  IF NOT EXISTS(SELECT 1 FROM audit_log l WHERE l.organization_id=NEW.organization_id AND l.resource_type='document' AND l.resource_id=root.id
    AND l.action='documents.expiry_recorded' AND l.actor_id=NEW.created_by AND l.occurred_at=NEW.created_at
    AND l.after->>'revisionId'=NEW.id::text AND l.after->>'documentId'=root.id::text AND l.after->>'versionId'=NEW.version_id::text
    AND l.after->>'previousRevisionId' IS NOT DISTINCT FROM NEW.previous_id::text
    AND l.after->>'expiresOn' IS NOT DISTINCT FROM NEW.expires_on::text AND l.after->>'number'=NEW.number::text
    AND l.after->>'commandHash'=NEW.command_hash AND l.after->>'sourceFingerprint'=NEW.source_fingerprint
    AND l.xmin::text=pg_current_xact_id()::xid::text AND NEW.xmin::text=l.xmin::text)
  THEN RAISE EXCEPTION 'document expiry requires its atomic private actor audit'; END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER document_expiry_revision_guard AFTER INSERT ON document_expiry_revision
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app_guard_document_expiry_revision();

-- Extend the shared document protocol fence; original generation/admission reuse
-- remains valid, while an expiry command cannot borrow any other protocol nonce.
CREATE OR REPLACE FUNCTION app_guard_document_signature_nonce() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE actor_uuid uuid;
BEGIN
  IF TG_TABLE_NAME='document_action' THEN IF NEW.action<>'SIGNED_ARCHIVE_RECONCILED' THEN RETURN NEW; END IF; actor_uuid:=NEW.actor_id;
  ELSIF TG_TABLE_NAME IN('signature','signature_provider_intent','signature_provider_identity_recovery') THEN actor_uuid:=NEW.requested_by; ELSE actor_uuid:=NEW.created_by; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.organization_id::text||':documents:nonce:'||actor_uuid::text||':'||NEW.command_key::text,0));
  IF TG_TABLE_NAME IN('signature','signature_provider_intent','signature_provider_identity_recovery','document_action','document_expiry_revision') AND (
    EXISTS(SELECT 1 FROM document_admission WHERE organization_id=NEW.organization_id AND created_by=actor_uuid AND command_key=NEW.command_key)
    OR EXISTS(SELECT 1 FROM document_instance WHERE organization_id=NEW.organization_id AND created_by=actor_uuid AND command_key=NEW.command_key))
    OR TG_TABLE_NAME<>'signature' AND EXISTS(SELECT 1 FROM signature WHERE organization_id=NEW.organization_id AND requested_by=actor_uuid AND command_key=NEW.command_key)
    OR TG_TABLE_NAME<>'signature_provider_intent' AND EXISTS(SELECT 1 FROM signature_provider_intent WHERE organization_id=NEW.organization_id AND requested_by=actor_uuid AND command_key=NEW.command_key)
    OR TG_TABLE_NAME<>'signature_provider_identity_recovery' AND EXISTS(SELECT 1 FROM signature_provider_identity_recovery WHERE organization_id=NEW.organization_id AND requested_by=actor_uuid AND command_key=NEW.command_key)
    OR TG_TABLE_NAME<>'document_action' AND EXISTS(SELECT 1 FROM document_action WHERE organization_id=NEW.organization_id AND actor_id=actor_uuid AND command_key=NEW.command_key AND action='SIGNED_ARCHIVE_RECONCILED')
    OR TG_TABLE_NAME<>'document_expiry_revision' AND EXISTS(SELECT 1 FROM document_expiry_revision WHERE organization_id=NEW.organization_id AND created_by=actor_uuid AND command_key=NEW.command_key)
  THEN RAISE EXCEPTION 'document command nonce belongs to another protocol'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER document_expiry_revision_nonce_guard BEFORE INSERT ON document_expiry_revision
  FOR EACH ROW EXECUTE FUNCTION app_guard_document_signature_nonce();

ALTER TABLE document_expiry_reminder ALTER COLUMN recipient_ids SET NOT NULL;
ALTER TABLE document_expiry_reminder ALTER COLUMN outbox_event_ids SET NOT NULL;
ALTER TABLE document_expiry_reminder ADD CONSTRAINT document_expiry_reminder_shape CHECK(coalesce(
  command_hash ~ '^[a-f0-9]{64}$' AND source_fingerprint ~ '^[a-f0-9]{64}$'
  AND stage_key ~ '^[a-z][a-z0-9_]{0,79}$' AND length(idempotency_key) BETWEEN 1 AND 400 AND observed_at<=clock_timestamp()
  AND jsonb_typeof(policy_snapshot)='object' AND jsonb_typeof(routing_snapshot)='object' AND jsonb_typeof(source_snapshot)='object'
  AND jsonb_typeof(authorization_snapshots)='object' AND cardinality(recipient_ids) BETWEEN 1 AND 100000
  AND cardinality(outbox_event_ids)=cardinality(recipient_ids) AND array_position(recipient_ids,NULL) IS NULL AND array_position(outbox_event_ids,NULL) IS NULL,false));

CREATE FUNCTION app_guard_document_expiry_reminder() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE revision document_expiry_revision%ROWTYPE; original document_version%ROWTYPE; root document%ROWTYPE;
  policy config_rule%ROWTYPE; routing config_rule%ROWTYPE; stage jsonb; effective_uuid uuid;
BEGIN
  SELECT * INTO revision FROM document_expiry_revision WHERE organization_id=NEW.organization_id AND id=NEW.revision_id;
  SELECT * INTO original FROM document_version WHERE organization_id=NEW.organization_id AND id=revision.version_id;
  SELECT * INTO root FROM document WHERE organization_id=NEW.organization_id AND id=original.document_id;
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.organization_id::text||':documents:expiry:'||revision.version_id::text,0));
  SELECT id INTO effective_uuid FROM document_version WHERE organization_id=NEW.organization_id AND document_id=root.id
    AND created_at<=NEW.observed_at AND (effective_from IS NULL OR effective_from<=NEW.observed_at) ORDER BY number DESC LIMIT 1;
  SELECT * INTO policy FROM config_rule WHERE organization_id=NEW.organization_id AND id=(NEW.policy_snapshot->>'id')::uuid;
  SELECT * INTO routing FROM config_rule WHERE organization_id=NEW.organization_id AND id=(NEW.routing_snapshot->>'id')::uuid;
  IF policy.id IS NOT NULL THEN SELECT value INTO stage FROM jsonb_array_elements(policy.value->'stages') WHERE value->>'key'=NEW.stage_key; END IF;
  IF revision.id IS NULL OR revision.expires_on IS NULL OR original.id IS NULL OR root.id IS NULL OR root.archived_at IS NOT NULL
    OR root.kind NOT IN('FILE','INSTANCE') OR effective_uuid IS DISTINCT FROM original.id
    OR EXISTS(SELECT 1 FROM document_expiry_revision WHERE organization_id=NEW.organization_id AND previous_id=revision.id)
    OR EXISTS(SELECT 1 FROM signature_signed_artifact WHERE organization_id=NEW.organization_id AND document_id=root.id)
    OR policy.id IS NULL OR policy.key<>'documents.expiry_reminders' OR policy.created_by IS DISTINCT FROM NEW.principal_id
    OR NEW.policy_snapshot IS DISTINCT FROM jsonb_build_object('id',policy.id,'version',policy.version,'value',policy.value)
    OR NOT coalesce(policy.value->'type_keys' ? root.type_key,false) OR stage IS NULL
    OR policy.value->>'source' IS DISTINCT FROM 'NATIVE_DOCUMENT_VERSIONS'
    OR policy.value->>'calendar' IS DISTINCT FROM 'ORGANIZATION_PROFILE'
    OR policy.value->>'principal' IS DISTINCT FROM 'CURRENT_CONFIGURATION_AUTHOR'
    OR policy.value->>'version_selection' IS DISTINCT FROM 'CURRENT_EFFECTIVE_VERSION'
    OR routing.id IS NULL OR routing.key<>'notification.routing.document_expiring'
    OR NEW.routing_snapshot IS DISTINCT FROM jsonb_build_object('id',routing.id,'version',routing.version,'value',routing.value)
    OR NEW.idempotency_key IS DISTINCT FROM 'document-expiry-reminder:'||policy.id::text||':'||revision.id::text||':'||NEW.stage_key||':'||NEW.occurred_on::text
    OR NEW.source_snapshot->>'documentId' IS DISTINCT FROM root.id::text OR NEW.source_snapshot->>'versionId' IS DISTINCT FROM original.id::text
    OR NEW.source_snapshot->>'revisionId' IS DISTINCT FROM revision.id::text OR NEW.source_snapshot->>'expiresOn' IS DISTINCT FROM revision.expires_on::text
    OR (SELECT count(DISTINCT value) FROM unnest(NEW.recipient_ids) value)<>cardinality(NEW.recipient_ids)
    OR (SELECT count(DISTINCT value) FROM unnest(NEW.outbox_event_ids) value)<>cardinality(NEW.outbox_event_ids)
    OR (SELECT count(*) FROM jsonb_object_keys(NEW.authorization_snapshots))<>cardinality(NEW.recipient_ids)
    OR EXISTS(SELECT 1 FROM unnest(NEW.recipient_ids) recipient WHERE NEW.authorization_snapshots->recipient::text->>'organizationId' IS DISTINCT FROM NEW.organization_id::text
      OR NEW.authorization_snapshots->recipient::text->>'userAccountId' IS DISTINCT FROM recipient::text)
  THEN RAISE EXCEPTION 'document expiry reminder requires its original active source, configured occurrence and captured recipients'; END IF;
  IF (SELECT count(*) FROM outbox_event e WHERE e.organization_id=NEW.organization_id AND e.id=ANY(NEW.outbox_event_ids)
    AND e.type='notification.requested' AND e.payload->>'kind'='document_expiring' AND e.payload->>'targetId'=NEW.id::text
    AND (e.payload->>'recipientId')::uuid=ANY(NEW.recipient_ids) AND e.occurred_at=NEW.observed_at
    AND e.xmin::text=pg_current_xact_id()::xid::text)<>cardinality(NEW.recipient_ids)
    OR EXISTS(SELECT 1 FROM unnest(NEW.recipient_ids) recipient WHERE NOT EXISTS(SELECT 1 FROM outbox_event e
      WHERE e.organization_id=NEW.organization_id AND e.id=ANY(NEW.outbox_event_ids) AND e.payload->>'recipientId'=recipient::text))
  THEN RAISE EXCEPTION 'document expiry reminder requires its actual atomic notification references'; END IF;
  IF NOT EXISTS(SELECT 1 FROM audit_log l WHERE l.organization_id=NEW.organization_id AND l.resource_type='document' AND l.resource_id=root.id
    AND l.action='documents.expiry_reminded' AND l.actor_id IS NULL AND l.occurred_at=NEW.observed_at
    AND l.after->>'principalId'=NEW.principal_id::text AND l.after->>'reminderId'=NEW.id::text AND l.after->>'revisionId'=revision.id::text AND l.after->>'versionId'=original.id::text
    AND l.after->>'commandHash'=NEW.command_hash AND l.after->>'sourceFingerprint'=NEW.source_fingerprint
    AND l.xmin::text=pg_current_xact_id()::xid::text AND NEW.xmin::text=l.xmin::text)
  THEN RAISE EXCEPTION 'document expiry reminder requires its atomic system audit'; END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER document_expiry_reminder_guard AFTER INSERT ON document_expiry_reminder
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app_guard_document_expiry_reminder();
