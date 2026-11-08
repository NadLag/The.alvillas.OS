-- CreateTable
CREATE TABLE "lead_profile_revision" (
    "id" UUID NOT NULL DEFAULT app_uuid_v7(),
    "organization_id" UUID NOT NULL,
    "lead_id" UUID NOT NULL,
    "previous_id" UUID,
    "number" INTEGER NOT NULL,
    "source_key" TEXT NOT NULL,
    "locale" TEXT NOT NULL,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "command_key" UUID NOT NULL,
    "command_hash" TEXT NOT NULL,
    "review_fingerprint" TEXT NOT NULL,
    "payload_schema_version" INTEGER NOT NULL DEFAULT 1,
    "encrypted_payload" BYTEA NOT NULL,
    "payload_sha256" TEXT NOT NULL,
    "policy_id" UUID NOT NULL,
    "policy_version" INTEGER NOT NULL,
    "policy_snapshot" JSONB NOT NULL,
    "capture_policy_id" UUID NOT NULL,
    "capture_policy_version" INTEGER NOT NULL,
    "capture_policy_snapshot" JSONB NOT NULL,
    "authorization_cap" JSONB NOT NULL,
    "request_id" TEXT NOT NULL,

    CONSTRAINT "lead_profile_revision_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "lead_profile_revision_organization_id_created_at_id_idx" ON "lead_profile_revision"("organization_id", "created_at", "id");

-- CreateIndex
CREATE UNIQUE INDEX "lead_profile_revision_organization_id_id_key" ON "lead_profile_revision"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "lead_profile_revision_organization_id_lead_id_id_key" ON "lead_profile_revision"("organization_id", "lead_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "lead_profile_revision_organization_id_lead_id_number_key" ON "lead_profile_revision"("organization_id", "lead_id", "number");

-- CreateIndex
CREATE UNIQUE INDEX "lead_profile_revision_organization_id_command_key_key" ON "lead_profile_revision"("organization_id", "command_key");

-- AddForeignKey
ALTER TABLE "lead_profile_revision" ADD CONSTRAINT "lead_profile_revision_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "lead_profile_revision" ADD CONSTRAINT "lead_profile_revision_organization_id_lead_id_fkey" FOREIGN KEY ("organization_id", "lead_id") REFERENCES "lead"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "lead_profile_revision" ADD CONSTRAINT "lead_profile_revision_organization_id_lead_id_previous_id_fkey" FOREIGN KEY ("organization_id", "lead_id", "previous_id") REFERENCES "lead_profile_revision"("organization_id", "lead_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "lead_profile_revision" ADD CONSTRAINT "lead_profile_revision_organization_id_created_by_fkey" FOREIGN KEY ("organization_id", "created_by") REFERENCES "user_account"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "lead_profile_revision" ADD CONSTRAINT "lead_profile_revision_organization_id_policy_id_fkey" FOREIGN KEY ("organization_id", "policy_id") REFERENCES "config_rule"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "lead_profile_revision" ADD CONSTRAINT "lead_profile_revision_organization_id_capture_policy_id_fkey" FOREIGN KEY ("organization_id", "capture_policy_id") REFERENCES "config_rule"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

ALTER TABLE lead_profile_revision ENABLE ROW LEVEL SECURITY;
ALTER TABLE lead_profile_revision FORCE ROW LEVEL SECURITY;
CREATE POLICY lead_profile_revision_tenant_isolation ON lead_profile_revision
  USING(organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid)
  WITH CHECK(organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid);
CREATE TRIGGER lead_profile_revision_immutable BEFORE UPDATE OR DELETE ON lead_profile_revision
  FOR EACH ROW EXECUTE FUNCTION app_lead_append_only();
ALTER TABLE lead_profile_revision ADD CONSTRAINT lead_profile_revision_shape CHECK(coalesce(
  number>0 AND number<2147483647 AND locale IN('en','fr','ar') AND source_key ~ '^[a-z][a-z0-9_]{0,119}$'
  AND payload_schema_version=1 AND octet_length(encrypted_payload) BETWEEN 64 AND 33024
  AND command_hash ~ '^[a-f0-9]{64}$' AND review_fingerprint ~ '^[a-f0-9]{64}$'
  AND payload_sha256=encode(sha256(encrypted_payload),'hex')
  AND policy_version>0 AND capture_policy_version>0
  AND jsonb_typeof(policy_snapshot)='object' AND jsonb_typeof(capture_policy_snapshot)='object'
  AND jsonb_typeof(authorization_cap)='object' AND length(request_id) BETWEEN 1 AND 1000,false));

CREATE FUNCTION app_guard_lead_profile_revision() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE original lead%ROWTYPE; predecessor lead_profile_revision%ROWTYPE; rule config_rule%ROWTYPE; capture config_rule%ROWTYPE;
BEGIN
  SELECT * INTO original FROM lead WHERE organization_id=NEW.organization_id AND id=NEW.lead_id;
  IF original.id IS NULL OR NEW.created_at<original.created_at OR NOT isfinite(NEW.created_at)
  THEN RAISE EXCEPTION 'lead profile requires its actual original tenant capture'; END IF;
  IF NEW.previous_id IS NULL THEN
    IF NEW.number<>1 THEN RAISE EXCEPTION 'lead profile requires its exact original position'; END IF;
  ELSE
    SELECT * INTO predecessor FROM lead_profile_revision WHERE organization_id=NEW.organization_id AND lead_id=NEW.lead_id AND id=NEW.previous_id;
    IF predecessor.id IS NULL OR NEW.number<>predecessor.number+1 OR NEW.created_at<predecessor.created_at
    THEN RAISE EXCEPTION 'lead profile requires its exact immutable predecessor'; END IF;
  END IF;
  SELECT * INTO rule FROM config_rule WHERE organization_id=NEW.organization_id AND id=NEW.policy_id;
  IF rule.id IS NULL OR rule.key<>'crm.lead_profile' OR rule.scope_type<>'organization' OR rule.scope_id IS NOT NULL
    OR rule.archived_at IS NOT NULL OR rule.lifecycle NOT IN('ACTIVE','RETIRED')
    OR NEW.created_at<rule.effective_from OR (rule.effective_to IS NOT NULL AND NEW.created_at>=rule.effective_to)
    OR NEW.policy_version<>rule.version OR NEW.policy_snapshot IS DISTINCT FROM jsonb_build_object('id',rule.id,'version',rule.version,'value',rule.value)
    OR rule.value->>'source' IS DISTINCT FROM 'NATIVE_IMMUTABLE_LEAD_PROFILE'
    OR rule.value->>'history' IS DISTINCT FROM 'APPEND_ONLY_REVIEWED_PROFILE_CORRECTIONS'
  THEN RAISE EXCEPTION 'lead profile requires its actual organization correction policy'; END IF;
  SELECT * INTO capture FROM config_rule WHERE organization_id=NEW.organization_id AND id=NEW.capture_policy_id;
  IF capture.id IS NULL OR capture.key<>'crm.lead_capture' OR capture.scope_type<>'organization' OR capture.scope_id IS NOT NULL
    OR capture.archived_at IS NOT NULL OR capture.lifecycle NOT IN('ACTIVE','RETIRED')
    OR NEW.created_at<capture.effective_from OR (capture.effective_to IS NOT NULL AND NEW.created_at>=capture.effective_to)
    OR NEW.capture_policy_version<>capture.version OR NEW.capture_policy_snapshot IS DISTINCT FROM jsonb_build_object('id',capture.id,'version',capture.version,'value',capture.value)
    OR capture.value->>'source' IS DISTINCT FROM 'NATIVE_PRIVATE_LEAD_CAPTURE'
    OR NOT coalesce(capture.value->'channels' ? original.channel,false)
    OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(capture.value->'sources') AS source(value)
      WHERE source.value->>'key'=NEW.source_key AND source.value->'channels' ? original.channel)
  THEN RAISE EXCEPTION 'lead profile requires its actual configured private field policy'; END IF;
  IF NOT EXISTS(SELECT 1 FROM audit_log l WHERE l.organization_id=NEW.organization_id AND l.actor_id=NEW.created_by
    AND l.action='crm.lead_profile_recorded' AND l.resource_type='lead' AND l.resource_id=NEW.lead_id
    AND l.request_id=NEW.request_id AND l.occurred_at=NEW.created_at
    AND l.after=jsonb_build_object('leadId',NEW.lead_id,'revisionId',NEW.id,'number',NEW.number,'previousRevisionId',NEW.previous_id,
      'sourceKey',NEW.source_key,'locale',NEW.locale,'commandHash',NEW.command_hash,'payloadSha256',NEW.payload_sha256,
      'policyId',NEW.policy_id,'capturePolicyId',NEW.capture_policy_id,'reviewFingerprint',NEW.review_fingerprint)
    AND l.xmin::text=pg_current_xact_id()::xid::text AND l.xmin::text=NEW.xmin::text)
  THEN RAISE EXCEPTION 'lead profile requires its atomic private actor audit'; END IF;
  IF NOT EXISTS(SELECT 1 FROM outbox_event e WHERE e.organization_id=NEW.organization_id
    AND e.type='crm.lead_profile_recorded' AND e.idempotency_key='crm.lead.profile.recorded:'||NEW.id::text
    AND e.payload=jsonb_build_object('leadId',NEW.lead_id,'revisionId',NEW.id,'number',NEW.number)
    AND e.occurred_at=NEW.created_at AND e.xmin::text=NEW.xmin::text)
  THEN RAISE EXCEPTION 'lead profile requires its atomic identifier-only outbox event'; END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER lead_profile_revision_guard AFTER INSERT ON lead_profile_revision
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app_guard_lead_profile_revision();
