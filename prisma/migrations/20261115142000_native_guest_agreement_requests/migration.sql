BEGIN;
-- CreateTable
CREATE TABLE "guest_hub_agreement_release" (
    "id" UUID NOT NULL DEFAULT app_uuid_v7(),
    "organization_id" UUID NOT NULL,
    "link_id" UUID NOT NULL,
    "reservation_id" UUID NOT NULL,
    "property_id" UUID NOT NULL,
    "guest_id" UUID NOT NULL,
    "previous_id" UUID,
    "version" INTEGER NOT NULL,
    "decision" TEXT NOT NULL,
    "preparation_id" UUID,
    "requested_locale" TEXT,
    "original_fingerprint" TEXT,
    "original_snapshot" JSONB NOT NULL,
    "document_authority_fingerprint" TEXT,
    "link_token_hash" TEXT NOT NULL,
    "policy_id" UUID,
    "policy_version" INTEGER,
    "policy_fingerprint" TEXT,
    "policy_snapshot" JSONB NOT NULL,
    "source_fingerprint" TEXT NOT NULL,
    "source_snapshot" JSONB NOT NULL,
    "authorization_cap" JSONB NOT NULL,
    "command_key" UUID NOT NULL,
    "command_hash" TEXT NOT NULL,
    "review_fingerprint" TEXT NOT NULL,
    "signature_version" TEXT NOT NULL,
    "signature" TEXT NOT NULL,
    "outbox_event_id" UUID NOT NULL,
    "reason" TEXT NOT NULL,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "request_id" TEXT NOT NULL,

    CONSTRAINT "guest_hub_agreement_release_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "guest_hub_agreement_request" (
    "id" UUID NOT NULL DEFAULT app_uuid_v7(),
    "organization_id" UUID NOT NULL,
    "link_id" UUID NOT NULL,
    "release_id" UUID NOT NULL,
    "reservation_id" UUID NOT NULL,
    "property_id" UUID NOT NULL,
    "guest_id" UUID NOT NULL,
    "preparation_id" UUID NOT NULL,
    "command_key" UUID NOT NULL,
    "command_hash" TEXT NOT NULL,
    "command_key_version" TEXT NOT NULL,
    "release_fingerprint" TEXT NOT NULL,
    "policy_id" UUID NOT NULL,
    "policy_version" INTEGER NOT NULL,
    "policy_fingerprint" TEXT NOT NULL,
    "policy_snapshot" JSONB NOT NULL,
    "source_fingerprint" TEXT NOT NULL,
    "source_snapshot" JSONB NOT NULL,
    "original_fingerprint" TEXT NOT NULL,
    "requested_locale" TEXT NOT NULL,
    "document_locale" TEXT NOT NULL,
    "encrypted_payload" BYTEA NOT NULL,
    "payload_sha256" TEXT NOT NULL,
    "payload_schema" INTEGER NOT NULL DEFAULT 1,
    "outbox_event_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL,
    "request_id" TEXT NOT NULL,

    CONSTRAINT "guest_hub_agreement_request_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "guest_hub_agreement_document_origin" (
    "id" UUID NOT NULL DEFAULT app_uuid_v7(),
    "organization_id" UUID NOT NULL,
    "guest_request_id" UUID NOT NULL,
    "distribution_intent_id" UUID NOT NULL,
    "delegated_by" UUID NOT NULL,
    "provenance" JSONB NOT NULL,
    "provenance_fingerprint" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL,
    "request_id" TEXT NOT NULL,

    CONSTRAINT "guest_hub_agreement_document_origin_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "guest_agreement_release_link_history_idx" ON "guest_hub_agreement_release"("organization_id", "link_id", "created_at", "id");

-- CreateIndex
CREATE UNIQUE INDEX "guest_agreement_release_org_id_key" ON "guest_hub_agreement_release"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "guest_agreement_release_version_key" ON "guest_hub_agreement_release"("organization_id", "link_id", "version");

-- CreateIndex
CREATE UNIQUE INDEX "guest_agreement_release_predecessor_key" ON "guest_hub_agreement_release"("organization_id", "previous_id");

-- CreateIndex
CREATE UNIQUE INDEX "guest_agreement_release_actor_nonce_key" ON "guest_hub_agreement_release"("organization_id", "created_by", "command_key");

-- CreateIndex
CREATE UNIQUE INDEX "guest_agreement_release_outbox_key" ON "guest_hub_agreement_release"("organization_id", "outbox_event_id");

-- CreateIndex
CREATE INDEX "guest_agreement_request_release_history_idx" ON "guest_hub_agreement_request"("organization_id", "release_id", "created_at", "id");

-- CreateIndex
CREATE UNIQUE INDEX "guest_agreement_request_org_id_key" ON "guest_hub_agreement_request"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "guest_agreement_request_nonce_key" ON "guest_hub_agreement_request"("organization_id", "link_id", "command_key");

-- CreateIndex
CREATE UNIQUE INDEX "guest_agreement_request_preparation_key" ON "guest_hub_agreement_request"("organization_id", "preparation_id");

-- CreateIndex
CREATE UNIQUE INDEX "guest_agreement_request_outbox_key" ON "guest_hub_agreement_request"("organization_id", "outbox_event_id");

-- CreateIndex
CREATE UNIQUE INDEX "guest_agreement_origin_org_id_key" ON "guest_hub_agreement_document_origin"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "guest_agreement_origin_request_key" ON "guest_hub_agreement_document_origin"("organization_id", "guest_request_id");

-- CreateIndex
CREATE UNIQUE INDEX "guest_agreement_origin_intent_key" ON "guest_hub_agreement_document_origin"("organization_id", "distribution_intent_id");

-- AddForeignKey
ALTER TABLE "guest_hub_agreement_release" ADD CONSTRAINT "guest_hub_agreement_release_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "guest_hub_agreement_release" ADD CONSTRAINT "guest_hub_agreement_release_organization_id_link_id_fkey" FOREIGN KEY ("organization_id", "link_id") REFERENCES "guest_hub_link"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "guest_hub_agreement_release" ADD CONSTRAINT "guest_hub_agreement_release_organization_id_reservation_id_fkey" FOREIGN KEY ("organization_id", "reservation_id") REFERENCES "reservation"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "guest_hub_agreement_release" ADD CONSTRAINT "guest_hub_agreement_release_organization_id_property_id_fkey" FOREIGN KEY ("organization_id", "property_id") REFERENCES "property"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "guest_hub_agreement_release" ADD CONSTRAINT "guest_hub_agreement_release_organization_id_guest_id_fkey" FOREIGN KEY ("organization_id", "guest_id") REFERENCES "guest"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "guest_hub_agreement_release" ADD CONSTRAINT "guest_hub_agreement_release_organization_id_policy_id_fkey" FOREIGN KEY ("organization_id", "policy_id") REFERENCES "config_rule"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "guest_hub_agreement_release" ADD CONSTRAINT "guest_hub_agreement_release_organization_id_preparation_id_fkey" FOREIGN KEY ("organization_id", "preparation_id") REFERENCES "signature_provider_intent"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "guest_hub_agreement_release" ADD CONSTRAINT "guest_hub_agreement_release_organization_id_created_by_fkey" FOREIGN KEY ("organization_id", "created_by") REFERENCES "user_account"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "guest_hub_agreement_release" ADD CONSTRAINT "guest_hub_agreement_release_organization_id_outbox_event_i_fkey" FOREIGN KEY ("organization_id", "outbox_event_id") REFERENCES "outbox_event"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "guest_hub_agreement_release" ADD CONSTRAINT "guest_hub_agreement_release_organization_id_previous_id_fkey" FOREIGN KEY ("organization_id", "previous_id") REFERENCES "guest_hub_agreement_release"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "guest_hub_agreement_request" ADD CONSTRAINT "guest_hub_agreement_request_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "guest_hub_agreement_request" ADD CONSTRAINT "guest_hub_agreement_request_organization_id_link_id_fkey" FOREIGN KEY ("organization_id", "link_id") REFERENCES "guest_hub_link"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "guest_hub_agreement_request" ADD CONSTRAINT "guest_hub_agreement_request_organization_id_release_id_fkey" FOREIGN KEY ("organization_id", "release_id") REFERENCES "guest_hub_agreement_release"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "guest_hub_agreement_request" ADD CONSTRAINT "guest_hub_agreement_request_organization_id_reservation_id_fkey" FOREIGN KEY ("organization_id", "reservation_id") REFERENCES "reservation"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "guest_hub_agreement_request" ADD CONSTRAINT "guest_hub_agreement_request_organization_id_property_id_fkey" FOREIGN KEY ("organization_id", "property_id") REFERENCES "property"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "guest_hub_agreement_request" ADD CONSTRAINT "guest_hub_agreement_request_organization_id_guest_id_fkey" FOREIGN KEY ("organization_id", "guest_id") REFERENCES "guest"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "guest_hub_agreement_request" ADD CONSTRAINT "guest_hub_agreement_request_organization_id_policy_id_fkey" FOREIGN KEY ("organization_id", "policy_id") REFERENCES "config_rule"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "guest_hub_agreement_request" ADD CONSTRAINT "guest_hub_agreement_request_organization_id_preparation_id_fkey" FOREIGN KEY ("organization_id", "preparation_id") REFERENCES "signature_provider_intent"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "guest_hub_agreement_request" ADD CONSTRAINT "guest_hub_agreement_request_organization_id_outbox_event_i_fkey" FOREIGN KEY ("organization_id", "outbox_event_id") REFERENCES "outbox_event"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "guest_hub_agreement_document_origin" ADD CONSTRAINT "guest_hub_agreement_document_origin_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "guest_hub_agreement_document_origin" ADD CONSTRAINT "guest_hub_agreement_document_origin_organization_id_guest__fkey" FOREIGN KEY ("organization_id", "guest_request_id") REFERENCES "guest_hub_agreement_request"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "guest_hub_agreement_document_origin" ADD CONSTRAINT "guest_hub_agreement_document_origin_organization_id_distri_fkey" FOREIGN KEY ("organization_id", "distribution_intent_id") REFERENCES "signature_provider_intent"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "guest_hub_agreement_document_origin" ADD CONSTRAINT "guest_hub_agreement_document_origin_organization_id_delega_fkey" FOREIGN KEY ("organization_id", "delegated_by") REFERENCES "user_account"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- Only decisions and original delegation live here. Signature state remains in
-- the existing native document tables. No business or financial row is rewritten.
ALTER TABLE guest_hub_agreement_release ENABLE ROW LEVEL SECURITY;
ALTER TABLE guest_hub_agreement_release FORCE ROW LEVEL SECURITY;
CREATE POLICY guest_agreement_release_tenant ON guest_hub_agreement_release
 USING(organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid)
 WITH CHECK(organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid);
ALTER TABLE guest_hub_agreement_request ENABLE ROW LEVEL SECURITY;
ALTER TABLE guest_hub_agreement_request FORCE ROW LEVEL SECURITY;
CREATE POLICY guest_agreement_request_tenant ON guest_hub_agreement_request
 USING(organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid)
 WITH CHECK(organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid);
ALTER TABLE guest_hub_agreement_document_origin ENABLE ROW LEVEL SECURITY;
ALTER TABLE guest_hub_agreement_document_origin FORCE ROW LEVEL SECURITY;
CREATE POLICY guest_agreement_origin_tenant ON guest_hub_agreement_document_origin
 USING(organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid)
 WITH CHECK(organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid);
CREATE TRIGGER guest_agreement_release_immutable BEFORE UPDATE OR DELETE ON guest_hub_agreement_release FOR EACH ROW EXECUTE FUNCTION app_onboarding_append_only();
CREATE TRIGGER guest_agreement_request_immutable BEFORE UPDATE OR DELETE ON guest_hub_agreement_request FOR EACH ROW EXECUTE FUNCTION app_onboarding_append_only();
CREATE TRIGGER guest_agreement_origin_immutable BEFORE UPDATE OR DELETE ON guest_hub_agreement_document_origin FOR EACH ROW EXECUTE FUNCTION app_onboarding_append_only();

CREATE FUNCTION app_guest_agreement_policy(org UUID,rule_id UUID,rule_version INTEGER,snapshot JSONB,res UUID,prop UUID,at_time TIMESTAMPTZ) RETURNS BOOLEAN LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE rule config_rule%ROWTYPE;r reservation%ROWTYPE;p property%ROWTYPE;
BEGIN
 SELECT * INTO rule FROM config_rule WHERE organization_id=org AND id=rule_id FOR SHARE;
 SELECT * INTO r FROM reservation WHERE organization_id=org AND id=res;
 SELECT * INTO p FROM property WHERE organization_id=org AND id=prop;
 RETURN coalesce(rule.id IS NOT NULL AND rule.key='guest_hub.guest_agreement' AND rule.created_by IS NOT NULL AND rule.lifecycle='ACTIVE'
  AND rule.version=rule_version AND snapshot=jsonb_build_object('id',rule.id::text,'version',rule.version,'value',rule.value)
  AND rule.effective_from<=at_time AND (rule.effective_to IS NULL OR rule.effective_to>at_time)
  AND rule.value->>'source'='NATIVE_GENERATED_GUEST_AGREEMENT' AND rule.value->>'history'='APPEND_ONLY_GUEST_AGREEMENT_REQUESTS' AND rule.value->>'enabled'='true'
  AND rule.value->>'signature_source'='EXISTING_NATIVE_DOCUMENT_SIGNATURE' AND rule.value->>'delivery'='EXISTING_NATIVE_SIGNATURE_EMAIL'
  AND length(btrim(rule.value->>'processing_approval_reference')) BETWEEN 1 AND 1000 AND length(btrim(rule.value->>'wording_approval_reference')) BETWEEN 1 AND 1000
  AND jsonb_typeof(rule.value->'notice')='object' AND jsonb_typeof(rule.value->'template_versions')='object'
  AND (rule.scope_type='organization' AND rule.scope_id IS NULL OR rule.scope_type='property' AND rule.scope_id=p.id OR rule.scope_type='city' AND rule.scope_id=p.city_id
   OR rule.scope_type='agreement' AND EXISTS(SELECT 1 FROM management_agreement a WHERE a.organization_id=org AND a.id=rule.scope_id AND a.property_id=p.id AND a.archived_at IS NULL AND a.status<>'DRAFT' AND a.effective_from<=at_time AND (a.effective_to IS NULL OR a.effective_to>at_time))
   OR rule.scope_type='booking_source_property' AND EXISTS(SELECT 1 FROM booking_channel c WHERE c.organization_id=org AND c.id=rule.scope_id AND c.property_id=p.id AND c.source_key=r.source AND c.archived_at IS NULL)),false);
END $$;
CREATE FUNCTION app_guest_agreement_original(org UUID,res UUID,prop UUID,guest UUID,prepared UUID,locale TEXT,original JSONB,policy JSONB) RETURNS BOOLEAN LANGUAGE sql STABLE SET search_path=public,pg_temp AS $$
 SELECT coalesce(original->>'protocol'='NATIVE_GUEST_AGREEMENT_ORIGINAL_V1' AND original->>'organizationId'=org::text AND original->>'reservationId'=res::text AND original->>'propertyId'=prop::text AND original->>'guestId'=guest::text
  AND original#>>'{document,typeKey}'=policy->>'document_type_key' AND original#>>'{document,templateKey}'=policy->>'template_key'
  AND original#>>'{document,locale}'=CASE WHEN locale='ar' AND policy#>>'{template_versions,ar}' IS NULL THEN policy->>'arabic_fallback_locale' ELSE locale END
  AND original#>>'{document,templateVersionId}'=policy->'template_versions'->>(original#>>'{document,locale}')
  AND EXISTS(SELECT 1 FROM signature_provider_intent pi
   JOIN signature s ON s.organization_id=pi.organization_id AND s.id=pi.signature_id
   JOIN document_instance i ON i.organization_id=s.organization_id AND i.id=s.instance_id
   JOIN document d ON d.organization_id=i.organization_id AND d.id=i.document_id
   JOIN document_version v ON v.organization_id=s.organization_id AND v.id=s.document_version_id AND v.document_id=d.id
   JOIN document_admission a ON a.organization_id=v.organization_id AND a.id=v.admission_id
   JOIN document_version tv ON tv.organization_id=i.organization_id AND tv.id=i.template_version_id
   JOIN document_template t ON t.organization_id=tv.organization_id AND t.document_id=tv.document_id
   JOIN signature_recipient recipient ON recipient.organization_id=s.organization_id AND recipient.signature_id=s.id
   JOIN signature_provider_attempt pa ON pa.organization_id=pi.organization_id AND pa.intent_id=pi.id AND pa.phase='PREPARE'
   JOIN signature_provider_evidence pe ON pe.organization_id=pa.organization_id AND pe.attempt_id=pa.id AND pe.kind='PREPARED'
   WHERE pi.organization_id=org AND pi.id=prepared AND pi.phase='PREPARE' AND d.source_kind='RESERVATION' AND d.source_id=res AND d.archived_at IS NULL
    AND d.type_key=policy->>'document_type_key' AND t.key=policy->>'template_key' AND t.locale=original#>>'{document,locale}'
    AND original#>>'{document,id}'=d.id::text AND original#>>'{document,instanceId}'=i.id::text AND original#>>'{document,versionId}'=v.id::text
    AND original#>>'{document,sha256}'=a.sha256 AND original#>>'{document,templateId}'=t.document_id::text AND original#>>'{document,templateVersionId}'=tv.id::text
    AND original#>>'{signature,id}'=s.id::text AND original#>>'{signature,documentVersionId}'=v.id::text
    AND original#>>'{signature,guestRecipientId}'=recipient.id::text AND recipient.guest_id=guest
    AND original#>'{signature,guestReference}'=jsonb_build_object('kind','GUEST','id',guest::text)
    AND original#>>'{signature,guestIdentityFingerprint}'=recipient.source_snapshot#>>'{identity,fingerprint}'
    AND pi.policy_snapshot#>>'{providerPolicy,value,signing,delivery,emailSettings,recipientSigningRequest}'='true'
    AND pe.provider_state='DRAFT' AND pe.provider_request_id IS NOT NULL),false)
$$;
ALTER TABLE guest_hub_agreement_release ADD CONSTRAINT guest_agreement_release_shape CHECK(coalesce(
 version>0 AND ((version=1)=(previous_id IS NULL)) AND decision IN('GRANTED','WITHDRAWN')
 AND isfinite(created_at) AND isfinite(expires_at) AND created_at=date_trunc('milliseconds',created_at) AND expires_at=date_trunc('milliseconds',expires_at)
 AND length(request_id) BETWEEN 1 AND 200 AND length(btrim(reason)) BETWEEN 1 AND 1000
 AND command_hash ~ '^[a-f0-9]{64}$' AND review_fingerprint ~ '^[a-f0-9]{64}$' AND source_fingerprint ~ '^[a-f0-9]{64}$'
 AND link_token_hash ~ '^[a-f0-9]{64}$' AND signature ~ '^[a-f0-9]{64}$' AND length(signature_version) BETWEEN 1 AND 120
 AND jsonb_typeof(source_snapshot)='object' AND source_fingerprint=encode(sha256(convert_to(app_onboarding_effect_json_text(source_snapshot),'UTF8')),'hex')
 AND jsonb_typeof(authorization_cap)='object' AND authorization_cap->>'schemaVersion'='1' AND authorization_cap->>'organizationId'=organization_id::text AND authorization_cap->>'userAccountId'=created_by::text
 AND (decision='WITHDRAWN' AND preparation_id IS NULL AND requested_locale IS NULL AND original_fingerprint IS NULL AND document_authority_fingerprint IS NULL AND original_snapshot='{}'::jsonb AND policy_id IS NULL AND policy_version IS NULL AND policy_fingerprint IS NULL AND policy_snapshot='{}'::jsonb
  OR decision='GRANTED' AND expires_at>created_at AND preparation_id IS NOT NULL AND requested_locale IN('en','fr','ar') AND original_fingerprint ~ '^[a-f0-9]{64}$' AND document_authority_fingerprint ~ '^[a-f0-9]{64}$'
   AND original_fingerprint=encode(sha256(convert_to(app_onboarding_effect_json_text(original_snapshot),'UTF8')),'hex') AND policy_id IS NOT NULL AND policy_version>0 AND policy_fingerprint=encode(sha256(convert_to(app_onboarding_effect_json_text(policy_snapshot),'UTF8')),'hex'))
 ,false));
CREATE FUNCTION app_guard_guest_agreement_release() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE original guest_hub_link%ROWTYPE;head guest_hub_agreement_release%ROWTYPE;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('guest-hub-link:'||NEW.organization_id::text||':'||NEW.link_id::text,0));
 SELECT * INTO original FROM guest_hub_link WHERE organization_id=NEW.organization_id AND id=NEW.link_id;
 SELECT * INTO head FROM guest_hub_agreement_release WHERE organization_id=NEW.organization_id AND link_id=NEW.link_id ORDER BY version DESC LIMIT 1;
 IF NOT coalesce(original.id IS NOT NULL AND original.reservation_id=NEW.reservation_id AND original.property_id=NEW.property_id AND original.guest_id=NEW.guest_id
  AND original.token_hash=NEW.link_token_hash AND original.expires_at=NEW.expires_at AND NEW.created_at>=original.created_at AND NEW.created_at<=clock_timestamp()
  AND (head.id IS NULL AND NEW.version=1 AND NEW.previous_id IS NULL OR head.id=NEW.previous_id AND NEW.version=head.version+1 AND NEW.created_at>=head.created_at)
  AND (NEW.decision='WITHDRAWN' OR NEW.created_at<original.expires_at
   AND NOT EXISTS(SELECT 1 FROM guest_hub_link_revocation WHERE organization_id=NEW.organization_id AND link_id=NEW.link_id)
   AND app_guest_profile_actual_source(NEW.organization_id,NEW.reservation_id,NEW.property_id,NEW.guest_id,NEW.source_snapshot)
   AND app_guest_agreement_policy(NEW.organization_id,NEW.policy_id,NEW.policy_version,NEW.policy_snapshot,NEW.reservation_id,NEW.property_id,NEW.created_at)
   AND app_guest_agreement_original(NEW.organization_id,NEW.reservation_id,NEW.property_id,NEW.guest_id,NEW.preparation_id,NEW.requested_locale,NEW.original_snapshot,NEW.policy_snapshot->'value')),false)
 THEN RAISE EXCEPTION 'guest_agreement_release_requires_exact_native_original_policy_and_predecessor';END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER guest_agreement_release_native_guard BEFORE INSERT ON guest_hub_agreement_release FOR EACH ROW EXECUTE FUNCTION app_guard_guest_agreement_release();

ALTER TABLE guest_hub_agreement_request ADD CONSTRAINT guest_agreement_request_shape CHECK(coalesce(
 payload_schema=1 AND policy_version>0 AND isfinite(created_at) AND created_at=date_trunc('milliseconds',created_at) AND length(request_id) BETWEEN 1 AND 200
 AND command_hash ~ '^[a-f0-9]{64}$' AND length(command_key_version) BETWEEN 1 AND 120 AND release_fingerprint ~ '^[a-f0-9]{64}$' AND original_fingerprint ~ '^[a-f0-9]{64}$'
 AND policy_fingerprint=encode(sha256(convert_to(app_onboarding_effect_json_text(policy_snapshot),'UTF8')),'hex') AND source_fingerprint=encode(sha256(convert_to(app_onboarding_effect_json_text(source_snapshot),'UTF8')),'hex')
 AND requested_locale IN('en','fr','ar') AND document_locale IN('en','fr','ar') AND octet_length(encrypted_payload) BETWEEN 64 AND 65536 AND payload_sha256=encode(sha256(encrypted_payload),'hex')
 ,false));
CREATE FUNCTION app_guard_guest_agreement_request() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE original guest_hub_link%ROWTYPE;release guest_hub_agreement_release%ROWTYPE;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('guest-hub-link:'||NEW.organization_id::text||':'||NEW.link_id::text,0));
 PERFORM pg_advisory_xact_lock(hashtextextended('guest-hub-agreement:'||NEW.organization_id::text||':'||NEW.preparation_id::text,0));
 SELECT * INTO original FROM guest_hub_link WHERE organization_id=NEW.organization_id AND id=NEW.link_id;
 SELECT * INTO release FROM guest_hub_agreement_release WHERE organization_id=NEW.organization_id AND link_id=NEW.link_id ORDER BY version DESC LIMIT 1;
 IF NOT coalesce(original.id IS NOT NULL AND original.reservation_id=NEW.reservation_id AND original.property_id=NEW.property_id AND original.guest_id=NEW.guest_id
  AND release.id=NEW.release_id AND release.decision='GRANTED' AND release.preparation_id=NEW.preparation_id AND release.original_fingerprint=NEW.original_fingerprint
  AND release.link_token_hash=original.token_hash AND NEW.document_locale=release.original_snapshot#>>'{document,locale}'
  AND NEW.source_snapshot=release.source_snapshot AND NEW.created_at>=release.created_at AND NEW.created_at<release.expires_at AND NEW.created_at<original.expires_at AND NEW.created_at<=clock_timestamp()
  AND NOT EXISTS(SELECT 1 FROM guest_hub_link_revocation WHERE organization_id=NEW.organization_id AND link_id=NEW.link_id)
  AND app_guest_profile_actual_source(NEW.organization_id,NEW.reservation_id,NEW.property_id,NEW.guest_id,NEW.source_snapshot)
  AND app_guest_agreement_policy(NEW.organization_id,NEW.policy_id,NEW.policy_version,NEW.policy_snapshot,NEW.reservation_id,NEW.property_id,NEW.created_at)
  AND (release.policy_snapshot->'value')-'submissions'=(NEW.policy_snapshot->'value')-'submissions',false)
 THEN RAISE EXCEPTION 'guest_agreement_request_requires_live_original_release_source_and_purpose';END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER guest_agreement_request_native_guard BEFORE INSERT ON guest_hub_agreement_request FOR EACH ROW EXECUTE FUNCTION app_guard_guest_agreement_request();

CREATE FUNCTION app_guard_guest_agreement_birth() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE event_type TEXT;event_payload JSONB;event_key TEXT;audit_after JSONB;actor UUID;explanation TEXT;
BEGIN
 IF TG_TABLE_NAME='guest_hub_agreement_release' THEN
  event_type:='guest_hub.agreement_release_recorded';actor:=NEW.created_by;explanation:=NEW.reason;
  event_payload:=jsonb_build_object('releaseId',NEW.id::text,'linkId',NEW.link_id::text,'reservationId',NEW.reservation_id::text,'decision',NEW.decision);
  event_key:='guest-hub-agreement-release:'||NEW.created_by::text||':'||NEW.command_key::text;
  audit_after:=event_payload||jsonb_build_object('commandHash',NEW.command_hash,'outboxEventId',NEW.outbox_event_id::text);
 ELSE
  event_type:='guest_hub.agreement_signature_requested';actor:=NULL;explanation:=NULL;
  event_payload:=jsonb_build_object('guestRequestId',NEW.id::text,'linkId',NEW.link_id::text,'reservationId',NEW.reservation_id::text);
  event_key:='guest-hub-agreement-request:'||NEW.link_id::text||':'||NEW.command_key::text;
  audit_after:=event_payload||jsonb_build_object('releaseId',NEW.release_id::text,'payloadSha256',NEW.payload_sha256,'outboxEventId',NEW.outbox_event_id::text);
 END IF;
 IF NOT EXISTS(SELECT 1 FROM outbox_event e WHERE e.organization_id=NEW.organization_id AND e.id=NEW.outbox_event_id AND e.type=event_type
  AND e.payload=event_payload AND e.idempotency_key=event_key AND e.occurred_at=NEW.created_at AND e.status='PENDING' AND e.attempt_count=0 AND e.xmin::text=pg_current_xact_id()::xid::text)
  OR NOT EXISTS(SELECT 1 FROM audit_log a WHERE a.organization_id=NEW.organization_id AND a.actor_id IS NOT DISTINCT FROM actor AND a.action=event_type AND a.resource_type='guest_hub_agreement'
   AND a.resource_id=NEW.id AND a.property_scope_id=NEW.property_id AND a.request_id=NEW.request_id AND a.reason IS NOT DISTINCT FROM explanation AND a.occurred_at=NEW.created_at
   AND a.after=audit_after AND a.xmin::text=pg_current_xact_id()::xid::text)
 THEN RAISE EXCEPTION 'guest_agreement_requires_exact_atomic_metadata_audit_and_outbox';END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER guest_agreement_release_birth_guard AFTER INSERT ON guest_hub_agreement_release DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app_guard_guest_agreement_birth();
CREATE CONSTRAINT TRIGGER guest_agreement_request_birth_guard AFTER INSERT ON guest_hub_agreement_request DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app_guard_guest_agreement_birth();

ALTER TABLE guest_hub_agreement_document_origin ADD CONSTRAINT guest_agreement_origin_shape CHECK(coalesce(
 isfinite(created_at) AND created_at=date_trunc('milliseconds',created_at) AND length(request_id) BETWEEN 1 AND 200
 AND provenance_fingerprint=encode(sha256(convert_to(app_onboarding_effect_json_text(provenance),'UTF8')),'hex')
 AND provenance->>'protocol'='NATIVE_GUEST_AGREEMENT_DISTRIBUTION_ORIGIN_V1' AND provenance->>'organizationId'=organization_id::text AND provenance->>'guestRequestId'=guest_request_id::text AND provenance->>'delegatedBy'=delegated_by::text,false));
CREATE FUNCTION app_guard_guest_agreement_origin_birth() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE request guest_hub_agreement_request%ROWTYPE;release guest_hub_agreement_release%ROWTYPE;intent signature_provider_intent%ROWTYPE;head UUID;
BEGIN
 SELECT * INTO request FROM guest_hub_agreement_request WHERE organization_id=NEW.organization_id AND id=NEW.guest_request_id;
 PERFORM pg_advisory_xact_lock(hashtextextended('guest-hub-link:'||NEW.organization_id::text||':'||request.link_id::text,0));
 SELECT * INTO release FROM guest_hub_agreement_release WHERE organization_id=NEW.organization_id AND id=request.release_id;
 SELECT id INTO head FROM guest_hub_agreement_release WHERE organization_id=NEW.organization_id AND link_id=request.link_id ORDER BY version DESC LIMIT 1;
 SELECT * INTO intent FROM signature_provider_intent WHERE organization_id=NEW.organization_id AND id=NEW.distribution_intent_id;
 IF NOT coalesce(request.id IS NOT NULL AND release.id=head AND release.decision='GRANTED' AND NEW.created_at<release.expires_at
  AND NOT EXISTS(SELECT 1 FROM guest_hub_link_revocation WHERE organization_id=NEW.organization_id AND link_id=request.link_id)
  AND app_guest_profile_actual_source(NEW.organization_id,request.reservation_id,request.property_id,request.guest_id,request.source_snapshot)
  AND intent.id IS NOT NULL AND intent.phase='SEND' AND intent.command_key=request.id AND intent.requested_by=NEW.delegated_by AND release.created_by=NEW.delegated_by
  AND intent.requested_at=NEW.created_at AND NEW.created_at>=request.created_at AND intent.input->'guestAgreement'=NEW.provenance
  AND NEW.provenance=jsonb_build_object('protocol','NATIVE_GUEST_AGREEMENT_DISTRIBUTION_ORIGIN_V1','organizationId',NEW.organization_id::text,'guestRequestId',request.id::text,'linkId',request.link_id::text,'releaseId',request.release_id::text,'preparationId',request.preparation_id::text,'reservationId',request.reservation_id::text,'propertyId',request.property_id::text,'guestId',request.guest_id::text,'delegatedBy',release.created_by::text,'releaseFingerprint',request.release_fingerprint,'originalFingerprint',request.original_fingerprint,'payloadSha256',request.payload_sha256)
  AND intent.input->>'preparationId'=request.preparation_id::text AND intent.xmin::text=pg_current_xact_id()::xid::text,false)
 THEN RAISE EXCEPTION 'guest_agreement_document_origin_requires_its_atomic_exact_native_distribution';END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER guest_agreement_origin_birth_guard AFTER INSERT ON guest_hub_agreement_document_origin DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app_guard_guest_agreement_origin_birth();

CREATE FUNCTION app_guard_guest_agreement_event_source() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN
  IF OLD.type IN('guest_hub.agreement_release_recorded','guest_hub.agreement_signature_requested') THEN RAISE EXCEPTION 'guest_agreement_original_event_immutable';END IF;
  RETURN OLD;
 END IF;
 IF OLD.type IN('guest_hub.agreement_release_recorded','guest_hub.agreement_signature_requested') OR NEW.type IN('guest_hub.agreement_release_recorded','guest_hub.agreement_signature_requested') THEN
  IF ROW(OLD.id,OLD.organization_id,OLD.type,OLD.payload,OLD.idempotency_key,OLD.occurred_at) IS DISTINCT FROM ROW(NEW.id,NEW.organization_id,NEW.type,NEW.payload,NEW.idempotency_key,NEW.occurred_at) THEN RAISE EXCEPTION 'guest_agreement_original_event_immutable';END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER guest_agreement_event_source_guard BEFORE UPDATE OR DELETE ON outbox_event FOR EACH ROW EXECUTE FUNCTION app_guard_guest_agreement_event_source();
CREATE FUNCTION app_guard_guest_agreement_event_birth() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
 IF NEW.type='guest_hub.agreement_release_recorded' AND NOT EXISTS(SELECT 1 FROM guest_hub_agreement_release r WHERE r.organization_id=NEW.organization_id AND r.outbox_event_id=NEW.id AND r.xmin::text=pg_current_xact_id()::xid::text)
  OR NEW.type='guest_hub.agreement_signature_requested' AND NOT EXISTS(SELECT 1 FROM guest_hub_agreement_request r WHERE r.organization_id=NEW.organization_id AND r.outbox_event_id=NEW.id AND r.xmin::text=pg_current_xact_id()::xid::text)
 THEN RAISE EXCEPTION 'guest_agreement_event_requires_its_atomic_native_record';END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER guest_agreement_event_birth_guard AFTER INSERT ON outbox_event DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app_guard_guest_agreement_event_birth();

-- Extend the native contract only for an atomic guest-origin admission.
CREATE OR REPLACE FUNCTION app_assert_signature_distribution_intent(original signature_provider_intent) RETURNS void LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE prepared signature_provider_intent%ROWTYPE; attempt signature_provider_attempt%ROWTYPE;
  evidence signature_provider_evidence%ROWTYPE; native signature%ROWTYPE; snapshot jsonb; command jsonb;
BEGIN
  snapshot:=original.policy_snapshot; command:=original.input;
  SELECT * INTO prepared FROM signature_provider_intent WHERE organization_id=original.organization_id AND id=(command->>'preparationId')::uuid AND phase='PREPARE';
  SELECT * INTO attempt FROM signature_provider_attempt WHERE organization_id=original.organization_id AND signature_id=original.signature_id AND phase='PREPARE';
  SELECT * INTO evidence FROM signature_provider_evidence WHERE organization_id=original.organization_id AND attempt_id=attempt.id AND kind='PREPARED';
  SELECT * INTO native FROM signature WHERE organization_id=original.organization_id AND id=original.signature_id;
  IF NOT coalesce(original.phase='SEND' AND snapshot->>'protocol'='ALVILLAS_SIGNATURE_DISTRIBUTION_V1' AND snapshot->>'schemaVersion'='1'
    AND snapshot->'command'=command AND snapshot->>'commandHash'=original.command_hash
    AND encode(digest(original.canonical_request,'sha256'),'hex')=original.command_hash
    AND original.canonical_request::jsonb=jsonb_build_object('organizationId',original.organization_id,'actorId',original.requested_by,'input',command)
    AND command->>'delivery'='EMAIL' AND command->>'idempotencyKey'=original.command_key::text AND command->>'reviewFingerprint' ~ '^[a-f0-9]{64}$' AND command->>'reason'=original.reason
    AND original.authorization_cap->>'schemaVersion'='1' AND original.authorization_cap->>'organizationId'=original.organization_id::text
    AND original.authorization_cap->>'userAccountId'=original.requested_by::text AND original.authorization_cap->'permissions' ? 'signature:edit'
    AND prepared.id IS NOT NULL AND attempt.id IS NOT NULL AND evidence.id IS NOT NULL AND native.id IS NOT NULL
    AND prepared.signature_id=original.signature_id AND attempt.intent_id=prepared.id AND attempt.signature_id=original.signature_id
    AND evidence.signature_id=original.signature_id AND evidence.phase='PREPARE' AND evidence.provider_state='DRAFT'
    AND snapshot->>'signatureId'=native.id::text AND snapshot->>'signatureCommandHash'=native.command_hash
    AND snapshot->>'contextFingerprint' ~ '^[a-f0-9]{64}$' AND snapshot->>'contractHash'=evidence.contract_hash
    AND original.provider_scope_hash=prepared.provider_scope_hash AND evidence.provider_scope_hash=prepared.provider_scope_hash
    AND original.source_fingerprint=prepared.source_fingerprint AND original.source_fingerprint=native.source_fingerprint
    AND snapshot->'document'=prepared.policy_snapshot->'document' AND snapshot->'providerPolicy'=prepared.policy_snapshot->'providerPolicy'
    AND snapshot->>'providerScopeHash'=prepared.provider_scope_hash AND snapshot->'recipients'=prepared.policy_snapshot->'recipients'
    AND snapshot->'preparation'=jsonb_build_object('intentId',prepared.id,'attemptId',attempt.id,'evidenceId',evidence.id,'commandHash',prepared.command_hash,'providerRequestId',evidence.provider_request_id)
    AND original.requested_at>=evidence.observed_at,false)
    OR EXISTS(SELECT 1 FROM jsonb_object_keys(command) k WHERE k NOT IN('preparationId','delivery','idempotencyKey','reviewFingerprint','reason','guestAgreement'))
  THEN RAISE EXCEPTION 'native distribution requires its exact prepared original, explicit email command and independently captured edit capability'; END IF;
  IF NOT EXISTS(SELECT 1 FROM audit_log a WHERE a.organization_id=original.organization_id AND ((NOT(command ? 'guestAgreement') AND a.actor_id=original.requested_by) OR (command ? 'guestAgreement' AND a.actor_id IS NULL)) AND a.resource_type='signature' AND a.resource_id=original.id
      AND a.action='documents.signature.distribution_requested' AND a.occurred_at=original.requested_at
      AND a.after=jsonb_build_object('signatureId',original.signature_id,'intentId',original.id,'preparationId',prepared.id,'commandHash',original.command_hash,'contractHash',snapshot->>'contractHash')
      AND a.xmin::text=pg_current_xact_id()::xid::text)
    OR NOT EXISTS(SELECT 1 FROM outbox_event e WHERE e.organization_id=original.organization_id AND e.type='documents.signature.distribute_requested' AND e.payload=jsonb_build_object('intentId',original.id)
      AND e.idempotency_key='document-signature-send:'||original.requested_by::text||':'||original.command_key::text AND e.occurred_at=original.requested_at AND e.xmin::text=pg_current_xact_id()::xid::text)
  THEN RAISE EXCEPTION 'native distribution requires atomic private intent audit and reference-only outbox'; END IF;
  IF command ? 'guestAgreement' AND NOT EXISTS(SELECT 1 FROM guest_hub_agreement_document_origin o WHERE o.organization_id=original.organization_id AND o.distribution_intent_id=original.id AND o.delegated_by=original.requested_by AND o.guest_request_id=original.command_key AND o.provenance=command->'guestAgreement' AND o.created_at=original.requested_at AND o.xmin::text=pg_current_xact_id()::xid::text)
  THEN RAISE EXCEPTION 'guest-origin native signature distribution requires its exact atomic guest request provenance';END IF;
END $$;
COMMIT;
