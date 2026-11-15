BEGIN;
-- CreateTable
CREATE TABLE "guest_hub_house_rules_acceptance" (
    "id" UUID NOT NULL DEFAULT app_uuid_v7(),
    "organization_id" UUID NOT NULL,
    "link_id" UUID NOT NULL,
    "grant_id" UUID NOT NULL,
    "reservation_id" UUID NOT NULL,
    "property_id" UUID NOT NULL,
    "guest_id" UUID NOT NULL,
    "previous_id" UUID,
    "version" INTEGER NOT NULL,
    "command_key" UUID NOT NULL,
    "command_hash" TEXT NOT NULL,
    "command_key_version" TEXT NOT NULL,
    "grant_fingerprint" TEXT NOT NULL,
    "policy_id" UUID NOT NULL,
    "policy_version" INTEGER NOT NULL,
    "policy_fingerprint" TEXT NOT NULL,
    "policy_snapshot" JSONB NOT NULL,
    "source_fingerprint" TEXT NOT NULL,
    "source_snapshot" JSONB NOT NULL,
    "rules_fingerprint" TEXT NOT NULL,
    "rules_snapshot" JSONB NOT NULL,
    "edition_fingerprint" TEXT NOT NULL,
    "rendered_fingerprint" TEXT NOT NULL,
    "requested_locale" TEXT NOT NULL,
    "displayed_locale" TEXT NOT NULL,
    "encrypted_payload" BYTEA NOT NULL,
    "payload_sha256" TEXT NOT NULL,
    "payload_schema" INTEGER NOT NULL DEFAULT 1,
    "outbox_event_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL,
    "request_id" TEXT NOT NULL,

    CONSTRAINT "guest_hub_house_rules_acceptance_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "guest_house_rules_link_history_idx" ON "guest_hub_house_rules_acceptance"("organization_id", "link_id", "created_at", "id");

-- CreateIndex
CREATE UNIQUE INDEX "guest_house_rules_org_id_key" ON "guest_hub_house_rules_acceptance"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "guest_house_rules_nonce_key" ON "guest_hub_house_rules_acceptance"("organization_id", "link_id", "command_key");

-- CreateIndex
CREATE UNIQUE INDEX "guest_house_rules_version_key" ON "guest_hub_house_rules_acceptance"("organization_id", "reservation_id", "guest_id", "version");

-- CreateIndex
CREATE UNIQUE INDEX "guest_house_rules_edition_key" ON "guest_hub_house_rules_acceptance"("organization_id", "reservation_id", "guest_id", "edition_fingerprint");

-- CreateIndex
CREATE UNIQUE INDEX "guest_house_rules_predecessor_key" ON "guest_hub_house_rules_acceptance"("organization_id", "previous_id");

-- CreateIndex
CREATE UNIQUE INDEX "guest_house_rules_outbox_key" ON "guest_hub_house_rules_acceptance"("organization_id", "outbox_event_id");

-- AddForeignKey
ALTER TABLE "guest_hub_house_rules_acceptance" ADD CONSTRAINT "guest_house_rules_organization_fk" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "guest_hub_house_rules_acceptance" ADD CONSTRAINT "guest_house_rules_link_fk" FOREIGN KEY ("organization_id", "link_id") REFERENCES "guest_hub_link"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "guest_hub_house_rules_acceptance" ADD CONSTRAINT "guest_house_rules_grant_fk" FOREIGN KEY ("organization_id", "grant_id") REFERENCES "guest_hub_form_grant"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "guest_hub_house_rules_acceptance" ADD CONSTRAINT "guest_house_rules_reservation_fk" FOREIGN KEY ("organization_id", "reservation_id") REFERENCES "reservation"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "guest_hub_house_rules_acceptance" ADD CONSTRAINT "guest_house_rules_property_fk" FOREIGN KEY ("organization_id", "property_id") REFERENCES "property"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "guest_hub_house_rules_acceptance" ADD CONSTRAINT "guest_house_rules_guest_fk" FOREIGN KEY ("organization_id", "guest_id") REFERENCES "guest"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "guest_hub_house_rules_acceptance" ADD CONSTRAINT "guest_house_rules_policy_fk" FOREIGN KEY ("organization_id", "policy_id") REFERENCES "config_rule"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "guest_hub_house_rules_acceptance" ADD CONSTRAINT "guest_house_rules_outbox_fk" FOREIGN KEY ("organization_id", "outbox_event_id") REFERENCES "outbox_event"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "guest_hub_house_rules_acceptance" ADD CONSTRAINT "guest_house_rules_previous_fk" FOREIGN KEY ("organization_id", "previous_id") REFERENCES "guest_hub_house_rules_acceptance"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;


-- The existing canonical JSON writer supports these ASCII protocol/locale keys,
-- string values and integer versions. It preserves ordered rules and Unicode text.
CREATE FUNCTION app_guest_house_rules_actual_content(org UUID,prop UUID,policy JSONB) RETURNS BOOLEAN LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE rules JSONB;
BEGIN
 SELECT house_rules INTO rules FROM property_onboarding_profile WHERE organization_id=org AND property_id=prop FOR SHARE;
 RETURN coalesce(jsonb_typeof(rules)='array' AND jsonb_array_length(rules) BETWEEN 1 AND 30
  AND policy->'approved_content'->'source_rules'=rules
  AND jsonb_typeof(policy->'approved_content'->'rules')='array'
  AND jsonb_array_length(policy->'approved_content'->'rules')=jsonb_array_length(rules)
  AND policy->>'require_acknowledgement'='true'
  AND length(btrim(policy->>'wording_approval_reference')) BETWEEN 1 AND 1000,false);
END $$;
CREATE FUNCTION app_guest_house_rules_edition(source_fingerprint TEXT,policy JSONB) RETURNS TEXT LANGUAGE sql IMMUTABLE SET search_path=public,pg_temp AS $$
 SELECT encode(sha256(convert_to(app_onboarding_effect_json_text(jsonb_build_object(
  'protocol','NATIVE_APPROVED_HOUSE_RULES_EDITION_V1','sourceFingerprint',source_fingerprint,
  'processingApprovalReference',policy->'processing_approval_reference','wordingApprovalReference',policy->'wording_approval_reference',
  'notice',policy->'notice','content',(policy->'approved_content')-'source_rules')),'UTF8')),'hex')
$$;
ALTER TABLE guest_hub_form_grant DROP CONSTRAINT guest_form_grant_shape;
ALTER TABLE guest_hub_form_grant ADD CONSTRAINT guest_form_grant_shape CHECK(coalesce(
 form_key IN('PROFILE','STAY_DETAILS','IDENTITY_DOCUMENTS','HOUSE_RULES') AND decision IN('GRANTED','WITHDRAWN') AND version>0 AND ((version=1)=(previous_id IS NULL))
 AND isfinite(created_at) AND isfinite(expires_at) AND created_at=date_trunc('milliseconds',created_at) AND expires_at=date_trunc('milliseconds',expires_at)
 AND command_hash ~ '^[a-f0-9]{64}$' AND review_fingerprint ~ '^[a-f0-9]{64}$' AND source_fingerprint ~ '^[a-f0-9]{64}$'
 AND link_token_hash ~ '^[a-f0-9]{64}$' AND signature ~ '^[a-f0-9]{64}$' AND length(signature_version) BETWEEN 1 AND 120
 AND length(btrim(reason)) BETWEEN 1 AND 1000 AND length(request_id) BETWEEN 1 AND 200
 AND jsonb_typeof(source_snapshot)='object' AND jsonb_typeof(policy_snapshot)='object'
 AND jsonb_typeof(authorization_cap)='object' AND authorization_cap->>'schemaVersion'='1'
 AND authorization_cap->>'organizationId'=organization_id::text AND authorization_cap->>'userAccountId'=created_by::text
 AND (decision='WITHDRAWN' AND policy_id IS NULL AND policy_version IS NULL AND policy_fingerprint IS NULL AND policy_snapshot='{}'::jsonb
  OR decision='GRANTED' AND expires_at>created_at AND policy_id IS NOT NULL AND policy_version>0 AND policy_fingerprint ~ '^[a-f0-9]{64}$'
   AND policy_snapshot->>'id'=policy_id::text AND policy_snapshot->>'version'=policy_version::text
   AND policy_snapshot-ARRAY['id','version','value']='{}'::jsonb AND jsonb_typeof(policy_snapshot->'value')='object')
 ,false));

CREATE OR REPLACE FUNCTION app_guest_form_actual_policy(org UUID,policy_id UUID,policy_version INTEGER,snapshot JSONB,res UUID,prop UUID,at_time TIMESTAMPTZ,form_key TEXT) RETURNS BOOLEAN LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE rule config_rule%ROWTYPE;r reservation%ROWTYPE;p property%ROWTYPE;
BEGIN
 SELECT * INTO rule FROM config_rule WHERE organization_id=org AND id=policy_id FOR SHARE;
 SELECT * INTO r FROM reservation WHERE organization_id=org AND id=res;
 SELECT * INTO p FROM property WHERE organization_id=org AND id=prop;
 RETURN coalesce(rule.id IS NOT NULL AND form_key IN('PROFILE','STAY_DETAILS','IDENTITY_DOCUMENTS','HOUSE_RULES') AND rule.key=CASE form_key WHEN 'PROFILE' THEN 'guest_hub.profile' WHEN 'STAY_DETAILS' THEN 'guest_hub.stay_details' WHEN 'IDENTITY_DOCUMENTS' THEN 'guest_hub.identity_documents' WHEN 'HOUSE_RULES' THEN 'guest_hub.house_rules' END AND rule.created_by IS NOT NULL AND rule.lifecycle='ACTIVE'
  AND rule.version=policy_version AND snapshot=jsonb_build_object('id',rule.id::text,'version',rule.version,'value',rule.value)
  AND rule.effective_from<=at_time AND (rule.effective_to IS NULL OR rule.effective_to>at_time)
  AND rule.value->>'source'=CASE form_key WHEN 'PROFILE' THEN 'NATIVE_RESERVATION_GUEST_PROFILE' WHEN 'STAY_DETAILS' THEN 'NATIVE_RESERVATION_GUEST_STAY_DETAILS' WHEN 'IDENTITY_DOCUMENTS' THEN 'NATIVE_GUEST_IDENTITY_DOCUMENTS' WHEN 'HOUSE_RULES' THEN 'NATIVE_PROPERTY_HOUSE_RULES_ACCEPTANCE' END AND rule.value->>'history'=CASE form_key WHEN 'PROFILE' THEN 'APPEND_ONLY_RESERVATION_PROFILE' WHEN 'STAY_DETAILS' THEN 'APPEND_ONLY_RESERVATION_STAY_DETAILS' WHEN 'IDENTITY_DOCUMENTS' THEN 'APPEND_ONLY_RESERVATION_IDENTITY_CAPTURES' WHEN 'HOUSE_RULES' THEN 'APPEND_ONLY_RESERVATION_HOUSE_RULES_ACCEPTANCE' END
  AND rule.value->>'enabled'='true' AND length(btrim(rule.value->>'processing_approval_reference')) BETWEEN 1 AND 1000
  AND jsonb_typeof(rule.value->'notice')='object'
  AND (form_key IN('PROFILE','STAY_DETAILS') AND jsonb_typeof(rule.value->'allowed_fields')='array'
   OR form_key='IDENTITY_DOCUMENTS' AND jsonb_typeof(rule.value->'document_types')='array' AND jsonb_array_length(rule.value->'document_types')>0
    AND rule.value->>'storage'='EXISTING_ENCRYPTED_DOCUMENT_ARCHIVE' AND length(btrim(rule.value->>'retention_approval_reference')) BETWEEN 1 AND 1000
   OR form_key='HOUSE_RULES' AND app_guest_house_rules_actual_content(org,prop,rule.value))
  AND (rule.scope_type='organization' AND rule.scope_id IS NULL OR rule.scope_type='property' AND rule.scope_id=p.id OR rule.scope_type='city' AND rule.scope_id=p.city_id
   OR rule.scope_type='agreement' AND EXISTS(SELECT 1 FROM management_agreement a WHERE a.organization_id=org AND a.id=rule.scope_id AND a.property_id=p.id AND a.archived_at IS NULL AND a.status<>'DRAFT' AND a.effective_from<=at_time AND (a.effective_to IS NULL OR a.effective_to>at_time))
   OR rule.scope_type='booking_source_property' AND EXISTS(SELECT 1 FROM booking_channel c WHERE c.organization_id=org AND c.id=rule.scope_id AND c.property_id=p.id AND c.source_key=r.source AND c.archived_at IS NULL)),false);
END $$;
CREATE OR REPLACE FUNCTION app_guard_guest_form_grant_birth() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM outbox_event e WHERE e.organization_id=NEW.organization_id AND e.id=NEW.outbox_event_id AND e.type='guest_hub.form_grant_recorded'
  AND e.payload=jsonb_build_object('grantId',NEW.id::text,'linkId',NEW.link_id::text,'reservationId',NEW.reservation_id::text,'formKey',NEW.form_key,'decision',NEW.decision)
  AND e.idempotency_key='guest-hub-form-grant:'||NEW.created_by::text||':'||NEW.command_key::text AND e.occurred_at=NEW.created_at AND e.status='PENDING' AND e.attempt_count=0 AND e.xmin::text=pg_current_xact_id()::xid::text)
  OR NOT EXISTS(SELECT 1 FROM audit_log a WHERE a.organization_id=NEW.organization_id AND a.actor_id=NEW.created_by AND a.action='guest_hub.form_grant_recorded' AND a.resource_type=CASE NEW.form_key WHEN 'PROFILE' THEN 'guest_hub_profile' WHEN 'STAY_DETAILS' THEN 'guest_hub_stay_details' WHEN 'IDENTITY_DOCUMENTS' THEN 'guest_hub_identity_documents' WHEN 'HOUSE_RULES' THEN 'guest_hub_house_rules' END
   AND a.resource_id=NEW.id AND a.property_scope_id=NEW.property_id AND a.request_id=NEW.request_id AND a.reason=NEW.reason AND a.occurred_at=NEW.created_at
   AND a.after=jsonb_build_object('grantId',NEW.id::text,'linkId',NEW.link_id::text,'reservationId',NEW.reservation_id::text,'formKey',NEW.form_key,'decision',NEW.decision,'commandHash',NEW.command_hash,'outboxEventId',NEW.outbox_event_id::text)
   AND a.xmin::text=pg_current_xact_id()::xid::text)
 THEN RAISE EXCEPTION 'guest_form_grant_requires_exact_atomic_metadata_event_and_audit';END IF;
 IF NEW.form_key='IDENTITY_DOCUMENTS' AND NEW.decision='GRANTED' AND NOT EXISTS(
  SELECT 1 FROM guest_hub_identity_document_delegation d WHERE d.organization_id=NEW.organization_id AND d.grant_id=NEW.id AND d.created_at=NEW.created_at AND d.xmin::text=pg_current_xact_id()::xid::text)
 THEN RAISE EXCEPTION 'guest_identity_grant_requires_atomic_original_document_authority_delegation';END IF;
 RETURN NULL;
END $$;

ALTER TABLE guest_hub_house_rules_acceptance ENABLE ROW LEVEL SECURITY;
ALTER TABLE guest_hub_house_rules_acceptance FORCE ROW LEVEL SECURITY;
CREATE POLICY guest_hub_house_rules_acceptance_tenant_isolation ON guest_hub_house_rules_acceptance
 USING(organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid)
 WITH CHECK(organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid);
CREATE TRIGGER guest_house_rules_immutable BEFORE UPDATE OR DELETE ON guest_hub_house_rules_acceptance FOR EACH ROW EXECUTE FUNCTION app_onboarding_append_only();
ALTER TABLE guest_hub_house_rules_acceptance ADD CONSTRAINT guest_house_rules_shape CHECK(coalesce(
 version>0 AND ((version=1)=(previous_id IS NULL)) AND payload_schema=1 AND policy_version>0
 AND isfinite(created_at) AND created_at=date_trunc('milliseconds',created_at) AND length(request_id) BETWEEN 1 AND 200
 AND command_hash ~ '^[a-f0-9]{64}$' AND length(command_key_version) BETWEEN 1 AND 120
 AND grant_fingerprint ~ '^[a-f0-9]{64}$' AND policy_fingerprint ~ '^[a-f0-9]{64}$' AND source_fingerprint ~ '^[a-f0-9]{64}$'
 AND rules_fingerprint ~ '^[a-f0-9]{64}$' AND edition_fingerprint ~ '^[a-f0-9]{64}$' AND rendered_fingerprint ~ '^[a-f0-9]{64}$'
 AND requested_locale IN('en','fr','ar') AND displayed_locale IN('en','fr','ar')
 AND (requested_locale=displayed_locale OR requested_locale='ar' AND displayed_locale='en')
 AND octet_length(encrypted_payload) BETWEEN 64 AND 65536 AND payload_sha256=encode(sha256(encrypted_payload),'hex')
 AND jsonb_typeof(source_snapshot)='object' AND jsonb_typeof(policy_snapshot)='object'
 AND policy_snapshot->>'id'=policy_id::text AND policy_snapshot->>'version'=policy_version::text
 AND policy_snapshot-ARRAY['id','version','value']='{}'::jsonb AND jsonb_typeof(policy_snapshot->'value')='object'
 AND rules_snapshot=jsonb_build_object('protocol','NATIVE_PROPERTY_HOUSE_RULES_SOURCE_V1','organizationId',organization_id::text,'propertyId',property_id::text,'rules',policy_snapshot#>'{value,approved_content,source_rules}')
 AND rules_fingerprint=encode(sha256(convert_to(app_onboarding_effect_json_text(rules_snapshot),'UTF8')),'hex')
 AND edition_fingerprint=app_guest_house_rules_edition(rules_fingerprint,policy_snapshot->'value')
 ,false));
CREATE FUNCTION app_guard_guest_house_rules_native() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE original guest_hub_link%ROWTYPE;grant_row guest_hub_form_grant%ROWTYPE;head guest_hub_house_rules_acceptance%ROWTYPE;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('guest-hub-link:'||NEW.organization_id::text||':'||NEW.link_id::text,0));
 PERFORM pg_advisory_xact_lock(hashtextextended('guest-hub-house-rules:'||NEW.organization_id::text||':'||NEW.reservation_id::text||':'||NEW.guest_id::text,0));
 SELECT * INTO original FROM guest_hub_link WHERE organization_id=NEW.organization_id AND id=NEW.link_id;
 SELECT * INTO grant_row FROM guest_hub_form_grant WHERE organization_id=NEW.organization_id AND link_id=NEW.link_id AND form_key='HOUSE_RULES' ORDER BY version DESC LIMIT 1;
 SELECT * INTO head FROM guest_hub_house_rules_acceptance WHERE organization_id=NEW.organization_id AND reservation_id=NEW.reservation_id AND guest_id=NEW.guest_id ORDER BY version DESC LIMIT 1;
 IF NOT coalesce(original.id IS NOT NULL AND original.reservation_id=NEW.reservation_id AND original.property_id=NEW.property_id AND original.guest_id=NEW.guest_id
  AND grant_row.id=NEW.grant_id AND grant_row.decision='GRANTED' AND grant_row.link_token_hash=original.token_hash
  AND NEW.created_at>=grant_row.created_at AND NEW.created_at<grant_row.expires_at AND NEW.created_at<original.expires_at AND NEW.created_at<=clock_timestamp()
  AND NOT EXISTS(SELECT 1 FROM guest_hub_link_revocation WHERE organization_id=NEW.organization_id AND link_id=NEW.link_id)
  AND (head.id IS NULL AND NEW.version=1 AND NEW.previous_id IS NULL OR head.id=NEW.previous_id AND NEW.version=head.version+1 AND NEW.created_at>=head.created_at)
  AND app_guest_profile_actual_source(NEW.organization_id,NEW.reservation_id,NEW.property_id,NEW.guest_id,NEW.source_snapshot)
  AND app_guest_form_actual_policy(NEW.organization_id,NEW.policy_id,NEW.policy_version,NEW.policy_snapshot,NEW.reservation_id,NEW.property_id,NEW.created_at,'HOUSE_RULES')
  AND grant_row.policy_snapshot#>>'{value,processing_approval_reference}'=NEW.policy_snapshot#>>'{value,processing_approval_reference}'
  AND grant_row.policy_snapshot#>>'{value,wording_approval_reference}'=NEW.policy_snapshot#>>'{value,wording_approval_reference}'
  AND grant_row.policy_snapshot#>'{value,notice}'=NEW.policy_snapshot#>'{value,notice}'
  AND grant_row.policy_snapshot#>'{value,approved_content}'=NEW.policy_snapshot#>'{value,approved_content}',false)
 THEN RAISE EXCEPTION 'guest_house_rules_requires_actual_edition_live_grant_policy_and_exact_predecessor';END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER guest_house_rules_native_guard BEFORE INSERT ON guest_hub_house_rules_acceptance FOR EACH ROW EXECUTE FUNCTION app_guard_guest_house_rules_native();
CREATE FUNCTION app_guard_guest_house_rules_birth() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM outbox_event e WHERE e.organization_id=NEW.organization_id AND e.id=NEW.outbox_event_id AND e.type='guest_hub.house_rules_accepted'
  AND e.payload=jsonb_build_object('acceptanceId',NEW.id::text,'linkId',NEW.link_id::text,'reservationId',NEW.reservation_id::text,'editionFingerprint',NEW.edition_fingerprint)
  AND e.idempotency_key='guest-hub-house-rules:'||NEW.link_id::text||':'||NEW.command_key::text AND e.occurred_at=NEW.created_at AND e.status='PENDING' AND e.attempt_count=0 AND e.xmin::text=pg_current_xact_id()::xid::text)
  OR NOT EXISTS(SELECT 1 FROM audit_log a WHERE a.organization_id=NEW.organization_id AND a.actor_id IS NULL AND a.action='guest_hub.house_rules_accepted' AND a.resource_type='guest_hub_house_rules'
   AND a.resource_id=NEW.id AND a.property_scope_id=NEW.property_id AND a.request_id=NEW.request_id AND a.occurred_at=NEW.created_at
   AND a.after=jsonb_build_object('acceptanceId',NEW.id::text,'linkId',NEW.link_id::text,'reservationId',NEW.reservation_id::text,'grantId',NEW.grant_id::text,'editionFingerprint',NEW.edition_fingerprint,'payloadSha256',NEW.payload_sha256,'outboxEventId',NEW.outbox_event_id::text)
   AND a.xmin::text=pg_current_xact_id()::xid::text)
 THEN RAISE EXCEPTION 'guest_house_rules_requires_exact_atomic_metadata_event_and_audit';END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER guest_house_rules_birth_guard AFTER INSERT ON guest_hub_house_rules_acceptance DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app_guard_guest_house_rules_birth();
CREATE FUNCTION app_guard_guest_house_rules_event_source() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN
  IF OLD.type='guest_hub.house_rules_accepted' THEN RAISE EXCEPTION 'guest_house_rules_original_event_source_immutable';END IF;
  RETURN OLD;
 END IF;
 IF OLD.type='guest_hub.house_rules_accepted' OR NEW.type='guest_hub.house_rules_accepted' THEN
  IF ROW(OLD.id,OLD.organization_id,OLD.type,OLD.payload,OLD.idempotency_key,OLD.occurred_at) IS DISTINCT FROM ROW(NEW.id,NEW.organization_id,NEW.type,NEW.payload,NEW.idempotency_key,NEW.occurred_at)
  THEN RAISE EXCEPTION 'guest_house_rules_original_event_source_immutable';END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER guest_house_rules_event_source_guard BEFORE UPDATE OR DELETE ON outbox_event FOR EACH ROW EXECUTE FUNCTION app_guard_guest_house_rules_event_source();
CREATE FUNCTION app_guard_guest_house_rules_event_birth() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
 IF NEW.type='guest_hub.house_rules_accepted' AND NOT EXISTS(SELECT 1 FROM guest_hub_house_rules_acceptance r WHERE r.organization_id=NEW.organization_id AND r.outbox_event_id=NEW.id AND r.xmin::text=pg_current_xact_id()::xid::text)
 THEN RAISE EXCEPTION 'guest_house_rules_event_requires_actual_atomic_native_acceptance';END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER guest_house_rules_event_birth_guard AFTER INSERT ON outbox_event DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app_guard_guest_house_rules_event_birth();
COMMIT;
