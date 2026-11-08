CREATE TABLE "lead" (
  "id" UUID NOT NULL DEFAULT app_uuid_v7(),
  "organization_id" UUID NOT NULL,
  "created_by" UUID NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "initial_stage" TEXT NOT NULL DEFAULT 'NEW',
  "channel" TEXT NOT NULL,
  "source_key" TEXT NOT NULL,
  "locale" TEXT NOT NULL,
  "command_key" UUID NOT NULL,
  "command_hash" TEXT NOT NULL,
  "payload_schema_version" INTEGER NOT NULL DEFAULT 1,
  "encrypted_payload" BYTEA NOT NULL,
  "payload_sha256" TEXT NOT NULL,
  "policy_id" UUID NOT NULL,
  "policy_version" INTEGER NOT NULL,
  "policy_snapshot" JSONB NOT NULL,
  "authorization_cap" JSONB NOT NULL,
  "request_id" TEXT NOT NULL,
  CONSTRAINT "lead_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "lead_organization_id_id_key" ON "lead"("organization_id","id");
CREATE UNIQUE INDEX "lead_organization_id_command_key_key" ON "lead"("organization_id","command_key");
CREATE INDEX "lead_organization_id_created_at_id_idx" ON "lead"("organization_id","created_at","id");
CREATE INDEX "lead_organization_id_source_key_created_at_id_idx" ON "lead"("organization_id","source_key","created_at","id");
ALTER TABLE "lead" ADD CONSTRAINT "lead_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE "lead" ADD CONSTRAINT "lead_organization_id_created_by_fkey" FOREIGN KEY ("organization_id","created_by") REFERENCES "user_account"("organization_id","id") ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE "lead" ADD CONSTRAINT "lead_organization_id_policy_id_fkey" FOREIGN KEY ("organization_id","policy_id") REFERENCES "config_rule"("organization_id","id") ON DELETE RESTRICT ON UPDATE NO ACTION;

ALTER TABLE lead ENABLE ROW LEVEL SECURITY;
ALTER TABLE lead FORCE ROW LEVEL SECURITY;
CREATE POLICY lead_tenant_isolation ON lead
  USING(organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid)
  WITH CHECK(organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid);

CREATE FUNCTION app_lead_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'original lead capture history is append-only'; END $$;
CREATE TRIGGER lead_immutable BEFORE UPDATE OR DELETE ON lead
  FOR EACH ROW EXECUTE FUNCTION app_lead_append_only();

ALTER TABLE lead ADD CONSTRAINT lead_shape CHECK(coalesce(
  initial_stage='NEW' AND payload_schema_version=1 AND channel IN('WEBSITE','MANUAL','REFERRAL') AND locale IN('en','fr','ar')
  AND source_key ~ '^[a-z0-9_.-]{1,120}$'
  AND command_hash ~ '^[a-f0-9]{64}$' AND payload_sha256 ~ '^[a-f0-9]{64}$'
  AND payload_sha256=encode(sha256(encrypted_payload),'hex')
  AND octet_length(encrypted_payload) BETWEEN 64 AND 33024
  AND policy_version>0 AND created_at<=clock_timestamp()
  AND jsonb_typeof(policy_snapshot)='object' AND jsonb_typeof(authorization_cap)='object'
  AND authorization_cap->>'organizationId'=organization_id::text
  AND authorization_cap->>'userAccountId'=created_by::text
  AND length(request_id) BETWEEN 1 AND 200,false));

CREATE FUNCTION app_guard_lead_capture() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE rule config_rule%ROWTYPE;
BEGIN
  SELECT * INTO rule FROM config_rule WHERE organization_id=NEW.organization_id AND id=NEW.policy_id;
  IF rule.id IS NULL OR rule.key<>'crm.lead_capture' OR rule.scope_type<>'organization' OR rule.scope_id IS NOT NULL
    OR rule.archived_at IS NOT NULL OR rule.lifecycle NOT IN('ACTIVE','RETIRED')
    OR NEW.created_at<rule.effective_from OR (rule.effective_to IS NOT NULL AND NEW.created_at>=rule.effective_to)
    OR NEW.policy_version<>rule.version
    OR NEW.policy_snapshot IS DISTINCT FROM jsonb_build_object('id',rule.id,'version',rule.version,'value',rule.value)
    OR rule.value->>'source' IS DISTINCT FROM 'NATIVE_PRIVATE_LEAD_CAPTURE'
    OR rule.value->>'encryption' IS DISTINCT FROM 'APP_MANAGED_AUTHENTICATED_ENCRYPTION'
    OR rule.value->>'history' IS DISTINCT FROM 'APPEND_ONLY_ORIGINAL_CAPTURE'
    OR NOT coalesce(rule.value->'channels' ? NEW.channel,false)
    OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(rule.value->'sources') AS configured(value)
      WHERE configured.value->>'key'=NEW.source_key AND configured.value->'channels' ? NEW.channel)
    OR length(btrim(coalesce(rule.value->>'processing_approval_reference','')))=0
    OR (NEW.channel='WEBSITE' AND (rule.created_by IS DISTINCT FROM NEW.created_by
      OR jsonb_typeof(rule.value->'website_notice') IS DISTINCT FROM 'object'
      OR NOT coalesce(rule.value->'website_notice'->>'notice_sha256' ~ '^[a-f0-9]{64}$',false)
      OR length(btrim(coalesce(rule.value->'website_notice'->>'approval_reference','')))=0))
  THEN RAISE EXCEPTION 'lead capture requires its actual organization policy, channel, author and encrypted original'; END IF;
  IF NOT EXISTS(SELECT 1 FROM audit_log l WHERE l.organization_id=NEW.organization_id AND l.resource_type='lead'
    AND l.resource_id=NEW.id AND l.action='crm.lead_captured'
    AND l.actor_id IS NOT DISTINCT FROM CASE WHEN NEW.channel='WEBSITE' THEN NULL::uuid ELSE NEW.created_by END
    AND l.request_id=NEW.request_id AND l.occurred_at=NEW.created_at
    AND l.after->>'principalId'=NEW.created_by::text AND l.after->>'leadId'=NEW.id::text
    AND l.after->>'channel'=NEW.channel AND l.after->>'sourceKey'=NEW.source_key
    AND l.after->>'commandHash'=NEW.command_hash AND l.after->>'payloadSha256'=NEW.payload_sha256
    AND l.after->>'policyId'=NEW.policy_id::text
    AND l.xmin::text=pg_current_xact_id()::xid::text AND NEW.xmin::text=l.xmin::text)
  THEN RAISE EXCEPTION 'lead capture requires its atomic private actor audit'; END IF;
  IF NOT EXISTS(SELECT 1 FROM outbox_event e WHERE e.organization_id=NEW.organization_id
    AND e.type='crm.lead_captured' AND e.idempotency_key='crm.lead.captured:'||NEW.id::text
    AND e.payload=jsonb_build_object('leadId',NEW.id,'channel',NEW.channel,'sourceKey',NEW.source_key)
    AND e.occurred_at=NEW.created_at AND e.xmin::text=NEW.xmin::text)
  THEN RAISE EXCEPTION 'lead capture requires its atomic private identifier-only outbox event'; END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER lead_capture_guard AFTER INSERT ON lead
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app_guard_lead_capture();
