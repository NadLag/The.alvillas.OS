BEGIN;
-- CreateTable
CREATE TABLE "guest_hub_form_grant" (
    "id" UUID NOT NULL DEFAULT app_uuid_v7(),
    "organization_id" UUID NOT NULL,
    "link_id" UUID NOT NULL,
    "reservation_id" UUID NOT NULL,
    "property_id" UUID NOT NULL,
    "guest_id" UUID NOT NULL,
    "form_key" TEXT NOT NULL,
    "previous_id" UUID,
    "version" INTEGER NOT NULL,
    "decision" TEXT NOT NULL,
    "link_token_hash" TEXT NOT NULL,
    "policy_id" UUID,
    "policy_version" INTEGER,
    "policy_fingerprint" TEXT,
    "policy_snapshot" JSONB NOT NULL,
    "source_fingerprint" TEXT NOT NULL,
    "source_snapshot" JSONB NOT NULL,
    "command_key" UUID NOT NULL,
    "command_hash" TEXT NOT NULL,
    "review_fingerprint" TEXT NOT NULL,
    "signature_version" TEXT NOT NULL,
    "signature" TEXT NOT NULL,
    "authorization_cap" JSONB NOT NULL,
    "outbox_event_id" UUID NOT NULL,
    "reason" TEXT NOT NULL,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "request_id" TEXT NOT NULL,

    CONSTRAINT "guest_hub_form_grant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "guest_hub_profile_revision" (
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
    "encrypted_payload" BYTEA NOT NULL,
    "payload_sha256" TEXT NOT NULL,
    "payload_schema" INTEGER NOT NULL DEFAULT 1,
    "outbox_event_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL,
    "request_id" TEXT NOT NULL,

    CONSTRAINT "guest_hub_profile_revision_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "guest_form_grant_reservation_idx" ON "guest_hub_form_grant"("organization_id", "reservation_id", "created_at", "id");

-- CreateIndex
CREATE UNIQUE INDEX "guest_form_grant_org_id_key" ON "guest_hub_form_grant"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "guest_form_grant_nonce_key" ON "guest_hub_form_grant"("organization_id", "command_key");

-- CreateIndex
CREATE UNIQUE INDEX "guest_form_grant_version_key" ON "guest_hub_form_grant"("organization_id", "link_id", "form_key", "version");

-- CreateIndex
CREATE UNIQUE INDEX "guest_form_grant_predecessor_key" ON "guest_hub_form_grant"("organization_id", "previous_id");

-- CreateIndex
CREATE UNIQUE INDEX "guest_form_grant_outbox_key" ON "guest_hub_form_grant"("organization_id", "outbox_event_id");

-- CreateIndex
CREATE INDEX "guest_profile_link_history_idx" ON "guest_hub_profile_revision"("organization_id", "link_id", "created_at", "id");

-- CreateIndex
CREATE UNIQUE INDEX "guest_profile_org_id_key" ON "guest_hub_profile_revision"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "guest_profile_nonce_key" ON "guest_hub_profile_revision"("organization_id", "link_id", "command_key");

-- CreateIndex
CREATE UNIQUE INDEX "guest_profile_version_key" ON "guest_hub_profile_revision"("organization_id", "reservation_id", "guest_id", "version");

-- CreateIndex
CREATE UNIQUE INDEX "guest_profile_predecessor_key" ON "guest_hub_profile_revision"("organization_id", "previous_id");

-- CreateIndex
CREATE UNIQUE INDEX "guest_profile_outbox_key" ON "guest_hub_profile_revision"("organization_id", "outbox_event_id");

-- AddForeignKey
ALTER TABLE "guest_hub_form_grant" ADD CONSTRAINT "guest_hub_form_grant_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "guest_hub_form_grant" ADD CONSTRAINT "guest_hub_form_grant_organization_id_link_id_fkey" FOREIGN KEY ("organization_id", "link_id") REFERENCES "guest_hub_link"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "guest_hub_form_grant" ADD CONSTRAINT "guest_hub_form_grant_organization_id_reservation_id_fkey" FOREIGN KEY ("organization_id", "reservation_id") REFERENCES "reservation"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "guest_hub_form_grant" ADD CONSTRAINT "guest_hub_form_grant_organization_id_property_id_fkey" FOREIGN KEY ("organization_id", "property_id") REFERENCES "property"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "guest_hub_form_grant" ADD CONSTRAINT "guest_hub_form_grant_organization_id_guest_id_fkey" FOREIGN KEY ("organization_id", "guest_id") REFERENCES "guest"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "guest_hub_form_grant" ADD CONSTRAINT "guest_hub_form_grant_organization_id_created_by_fkey" FOREIGN KEY ("organization_id", "created_by") REFERENCES "user_account"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "guest_hub_form_grant" ADD CONSTRAINT "guest_hub_form_grant_organization_id_policy_id_fkey" FOREIGN KEY ("organization_id", "policy_id") REFERENCES "config_rule"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "guest_hub_form_grant" ADD CONSTRAINT "guest_hub_form_grant_organization_id_outbox_event_id_fkey" FOREIGN KEY ("organization_id", "outbox_event_id") REFERENCES "outbox_event"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "guest_hub_form_grant" ADD CONSTRAINT "guest_hub_form_grant_organization_id_previous_id_fkey" FOREIGN KEY ("organization_id", "previous_id") REFERENCES "guest_hub_form_grant"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "guest_hub_profile_revision" ADD CONSTRAINT "guest_hub_profile_revision_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "guest_hub_profile_revision" ADD CONSTRAINT "guest_hub_profile_revision_organization_id_link_id_fkey" FOREIGN KEY ("organization_id", "link_id") REFERENCES "guest_hub_link"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "guest_hub_profile_revision" ADD CONSTRAINT "guest_hub_profile_revision_organization_id_grant_id_fkey" FOREIGN KEY ("organization_id", "grant_id") REFERENCES "guest_hub_form_grant"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "guest_hub_profile_revision" ADD CONSTRAINT "guest_hub_profile_revision_organization_id_reservation_id_fkey" FOREIGN KEY ("organization_id", "reservation_id") REFERENCES "reservation"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "guest_hub_profile_revision" ADD CONSTRAINT "guest_hub_profile_revision_organization_id_property_id_fkey" FOREIGN KEY ("organization_id", "property_id") REFERENCES "property"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "guest_hub_profile_revision" ADD CONSTRAINT "guest_hub_profile_revision_organization_id_guest_id_fkey" FOREIGN KEY ("organization_id", "guest_id") REFERENCES "guest"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "guest_hub_profile_revision" ADD CONSTRAINT "guest_hub_profile_revision_organization_id_policy_id_fkey" FOREIGN KEY ("organization_id", "policy_id") REFERENCES "config_rule"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "guest_hub_profile_revision" ADD CONSTRAINT "guest_hub_profile_revision_organization_id_outbox_event_id_fkey" FOREIGN KEY ("organization_id", "outbox_event_id") REFERENCES "outbox_event"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "guest_hub_profile_revision" ADD CONSTRAINT "guest_hub_profile_revision_organization_id_previous_id_fkey" FOREIGN KEY ("organization_id", "previous_id") REFERENCES "guest_hub_profile_revision"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;


ALTER TABLE guest_hub_form_grant ENABLE ROW LEVEL SECURITY;
ALTER TABLE guest_hub_form_grant FORCE ROW LEVEL SECURITY;
CREATE POLICY guest_hub_form_grant_tenant_isolation ON guest_hub_form_grant
 USING(organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid)
 WITH CHECK(organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid);
ALTER TABLE guest_hub_profile_revision ENABLE ROW LEVEL SECURITY;
ALTER TABLE guest_hub_profile_revision FORCE ROW LEVEL SECURITY;
CREATE POLICY guest_hub_profile_revision_tenant_isolation ON guest_hub_profile_revision
 USING(organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid)
 WITH CHECK(organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid);
CREATE TRIGGER guest_form_grant_immutable BEFORE UPDATE OR DELETE ON guest_hub_form_grant FOR EACH ROW EXECUTE FUNCTION app_onboarding_append_only();
CREATE TRIGGER guest_profile_immutable BEFORE UPDATE OR DELETE ON guest_hub_profile_revision FOR EACH ROW EXECUTE FUNCTION app_onboarding_append_only();

ALTER TABLE guest_hub_form_grant ADD CONSTRAINT guest_form_grant_shape CHECK(coalesce(
 form_key='PROFILE' AND decision IN('GRANTED','WITHDRAWN') AND version>0 AND ((version=1)=(previous_id IS NULL))
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
ALTER TABLE guest_hub_profile_revision ADD CONSTRAINT guest_profile_shape CHECK(coalesce(
 version>0 AND ((version=1)=(previous_id IS NULL)) AND payload_schema=1 AND policy_version>0
 AND isfinite(created_at) AND created_at=date_trunc('milliseconds',created_at) AND length(request_id) BETWEEN 1 AND 200
 AND command_hash ~ '^[a-f0-9]{64}$' AND length(command_key_version) BETWEEN 1 AND 120
 AND grant_fingerprint ~ '^[a-f0-9]{64}$' AND policy_fingerprint ~ '^[a-f0-9]{64}$' AND source_fingerprint ~ '^[a-f0-9]{64}$'
 AND octet_length(encrypted_payload) BETWEEN 64 AND 16384 AND payload_sha256=encode(sha256(encrypted_payload),'hex')
 AND jsonb_typeof(source_snapshot)='object' AND jsonb_typeof(policy_snapshot)='object'
 AND policy_snapshot->>'id'=policy_id::text AND policy_snapshot->>'version'=policy_version::text
 AND policy_snapshot-ARRAY['id','version','value']='{}'::jsonb AND jsonb_typeof(policy_snapshot->'value')='object'
 ,false));

CREATE FUNCTION app_guest_profile_actual_source(org UUID,res UUID,prop UUID,person UUID,snapshot JSONB) RETURNS BOOLEAN LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE r reservation%ROWTYPE;p property%ROWTYPE;g guest%ROWTYPE;rv TEXT;rt TEXT;pv TEXT;pt TEXT;gv TEXT;gt TEXT;
BEGIN
 SELECT * INTO r FROM reservation WHERE organization_id=org AND id=res FOR SHARE;
 SELECT * INTO p FROM property WHERE organization_id=org AND id=prop FOR SHARE;
 SELECT * INTO g FROM guest WHERE organization_id=org AND id=person FOR SHARE;
 SELECT xmin::text,ctid::text INTO rv,rt FROM reservation WHERE organization_id=org AND id=res;
 SELECT xmin::text,ctid::text INTO pv,pt FROM property WHERE organization_id=org AND id=prop;
 SELECT xmin::text,ctid::text INTO gv,gt FROM guest WHERE organization_id=org AND id=person;
 RETURN coalesce(r.id IS NOT NULL AND p.id IS NOT NULL AND g.id IS NOT NULL AND r.property_id=p.id AND r.guest_id=g.id
  AND r.archived_at IS NULL AND p.archived_at IS NULL AND g.archived_at IS NULL AND g.merged_into_id IS NULL
  AND snapshot=jsonb_build_object('protocol','NATIVE_GUEST_LINK_SOURCE_V1','organizationId',org::text,'reservationId',res::text,'propertyId',prop::text,'guestId',person::text,
   'reservationVersion',rv,'reservationTuple',rt,'reservationNumber',r.version,'propertyVersion',pv,'propertyTuple',pt,'guestVersion',gv,'guestTuple',gt,'checkOut',r.check_out::text,'timezone',p.timezone),false);
END $$;

CREATE FUNCTION app_guest_profile_actual_policy(org UUID,policy_id UUID,policy_version INTEGER,snapshot JSONB,res UUID,prop UUID,at_time TIMESTAMPTZ) RETURNS BOOLEAN LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE rule config_rule%ROWTYPE;r reservation%ROWTYPE;p property%ROWTYPE;
BEGIN
 SELECT * INTO rule FROM config_rule WHERE organization_id=org AND id=policy_id FOR SHARE;
 SELECT * INTO r FROM reservation WHERE organization_id=org AND id=res;
 SELECT * INTO p FROM property WHERE organization_id=org AND id=prop;
 RETURN coalesce(rule.id IS NOT NULL AND rule.key='guest_hub.profile' AND rule.created_by IS NOT NULL AND rule.lifecycle='ACTIVE'
  AND rule.version=policy_version AND snapshot=jsonb_build_object('id',rule.id::text,'version',rule.version,'value',rule.value)
  AND rule.effective_from<=at_time AND (rule.effective_to IS NULL OR rule.effective_to>at_time)
  AND rule.value->>'source'='NATIVE_RESERVATION_GUEST_PROFILE' AND rule.value->>'history'='APPEND_ONLY_RESERVATION_PROFILE'
  AND rule.value->>'enabled'='true' AND length(btrim(rule.value->>'processing_approval_reference')) BETWEEN 1 AND 1000
  AND jsonb_typeof(rule.value->'notice')='object' AND jsonb_typeof(rule.value->'allowed_fields')='array'
  AND (rule.scope_type='organization' AND rule.scope_id IS NULL OR rule.scope_type='property' AND rule.scope_id=p.id OR rule.scope_type='city' AND rule.scope_id=p.city_id
   OR rule.scope_type='agreement' AND EXISTS(SELECT 1 FROM management_agreement a WHERE a.organization_id=org AND a.id=rule.scope_id AND a.property_id=p.id AND a.archived_at IS NULL AND a.status<>'DRAFT' AND a.effective_from<=at_time AND (a.effective_to IS NULL OR a.effective_to>at_time))
   OR rule.scope_type='booking_source_property' AND EXISTS(SELECT 1 FROM booking_channel c WHERE c.organization_id=org AND c.id=rule.scope_id AND c.property_id=p.id AND c.source_key=r.source AND c.archived_at IS NULL)),false);
END $$;

CREATE FUNCTION app_guard_guest_form_grant_native() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE original guest_hub_link%ROWTYPE;head guest_hub_form_grant%ROWTYPE;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('guest-hub-link:'||NEW.organization_id::text||':'||NEW.link_id::text,0));
 SELECT * INTO original FROM guest_hub_link WHERE organization_id=NEW.organization_id AND id=NEW.link_id;
 SELECT * INTO head FROM guest_hub_form_grant WHERE organization_id=NEW.organization_id AND link_id=NEW.link_id AND form_key=NEW.form_key ORDER BY version DESC LIMIT 1;
 IF NOT coalesce(original.id IS NOT NULL AND NEW.reservation_id=original.reservation_id AND NEW.property_id=original.property_id AND NEW.guest_id=original.guest_id
  AND NEW.link_token_hash=original.token_hash AND NEW.expires_at=original.expires_at AND NEW.created_at>=original.created_at AND NEW.created_at<=clock_timestamp()
  AND (head.id IS NULL AND NEW.version=1 AND NEW.previous_id IS NULL OR head.id=NEW.previous_id AND NEW.version=head.version+1 AND NEW.created_at>=head.created_at),false)
 THEN RAISE EXCEPTION 'guest_form_grant_requires_original_link_and_exact_native_predecessor';END IF;
 IF NEW.decision='GRANTED' AND (NOT app_guest_profile_actual_source(NEW.organization_id,NEW.reservation_id,NEW.property_id,NEW.guest_id,NEW.source_snapshot)
  OR NOT app_guest_profile_actual_policy(NEW.organization_id,NEW.policy_id,NEW.policy_version,NEW.policy_snapshot,NEW.reservation_id,NEW.property_id,NEW.created_at)
  OR EXISTS(SELECT 1 FROM guest_hub_link_revocation WHERE organization_id=NEW.organization_id AND link_id=NEW.link_id))
 THEN RAISE EXCEPTION 'guest_form_grant_requires_actual_source_approved_policy_and_live_original';END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER guest_form_grant_native_guard BEFORE INSERT ON guest_hub_form_grant FOR EACH ROW EXECUTE FUNCTION app_guard_guest_form_grant_native();

CREATE FUNCTION app_guard_guest_profile_native() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE original guest_hub_link%ROWTYPE;grant_row guest_hub_form_grant%ROWTYPE;head guest_hub_profile_revision%ROWTYPE;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('guest-hub-link:'||NEW.organization_id::text||':'||NEW.link_id::text,0));
 PERFORM pg_advisory_xact_lock(hashtextextended('guest-hub-profile:'||NEW.organization_id::text||':'||NEW.reservation_id::text||':'||NEW.guest_id::text,0));
 SELECT * INTO original FROM guest_hub_link WHERE organization_id=NEW.organization_id AND id=NEW.link_id;
 SELECT * INTO grant_row FROM guest_hub_form_grant WHERE organization_id=NEW.organization_id AND link_id=NEW.link_id AND form_key='PROFILE' ORDER BY version DESC LIMIT 1;
 SELECT * INTO head FROM guest_hub_profile_revision WHERE organization_id=NEW.organization_id AND reservation_id=NEW.reservation_id AND guest_id=NEW.guest_id ORDER BY version DESC LIMIT 1;
 IF NOT coalesce(original.id IS NOT NULL AND original.reservation_id=NEW.reservation_id AND original.property_id=NEW.property_id AND original.guest_id=NEW.guest_id
  AND grant_row.id=NEW.grant_id AND grant_row.decision='GRANTED' AND grant_row.link_token_hash=original.token_hash
  AND NEW.created_at>=grant_row.created_at AND NEW.created_at<grant_row.expires_at AND NEW.created_at<original.expires_at AND NEW.created_at<=clock_timestamp()
  AND NOT EXISTS(SELECT 1 FROM guest_hub_link_revocation WHERE organization_id=NEW.organization_id AND link_id=NEW.link_id)
  AND (head.id IS NULL AND NEW.version=1 AND NEW.previous_id IS NULL OR head.id=NEW.previous_id AND NEW.version=head.version+1 AND NEW.created_at>=head.created_at)
  AND app_guest_profile_actual_source(NEW.organization_id,NEW.reservation_id,NEW.property_id,NEW.guest_id,NEW.source_snapshot)
  AND app_guest_profile_actual_policy(NEW.organization_id,NEW.policy_id,NEW.policy_version,NEW.policy_snapshot,NEW.reservation_id,NEW.property_id,NEW.created_at),false)
 THEN RAISE EXCEPTION 'guest_profile_requires_actual_source_live_grant_policy_and_exact_predecessor';END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER guest_profile_native_guard BEFORE INSERT ON guest_hub_profile_revision FOR EACH ROW EXECUTE FUNCTION app_guard_guest_profile_native();

CREATE FUNCTION app_guard_guest_form_grant_birth() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM outbox_event e WHERE e.organization_id=NEW.organization_id AND e.id=NEW.outbox_event_id AND e.type='guest_hub.form_grant_recorded'
  AND e.payload=jsonb_build_object('grantId',NEW.id::text,'linkId',NEW.link_id::text,'reservationId',NEW.reservation_id::text,'formKey',NEW.form_key,'decision',NEW.decision)
  AND e.idempotency_key='guest-hub-form-grant:'||NEW.created_by::text||':'||NEW.command_key::text AND e.occurred_at=NEW.created_at AND e.status='PENDING' AND e.attempt_count=0 AND e.xmin::text=pg_current_xact_id()::xid::text)
  OR NOT EXISTS(SELECT 1 FROM audit_log a WHERE a.organization_id=NEW.organization_id AND a.actor_id=NEW.created_by AND a.action='guest_hub.form_grant_recorded' AND a.resource_type='guest_hub_profile'
   AND a.resource_id=NEW.id AND a.property_scope_id=NEW.property_id AND a.request_id=NEW.request_id AND a.reason=NEW.reason AND a.occurred_at=NEW.created_at
   AND a.after=jsonb_build_object('grantId',NEW.id::text,'linkId',NEW.link_id::text,'reservationId',NEW.reservation_id::text,'formKey',NEW.form_key,'decision',NEW.decision,'commandHash',NEW.command_hash,'outboxEventId',NEW.outbox_event_id::text)
   AND a.xmin::text=pg_current_xact_id()::xid::text)
 THEN RAISE EXCEPTION 'guest_form_grant_requires_exact_atomic_metadata_event_and_audit';END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER guest_form_grant_birth_guard AFTER INSERT ON guest_hub_form_grant DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app_guard_guest_form_grant_birth();

CREATE FUNCTION app_guard_guest_profile_birth() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM outbox_event e WHERE e.organization_id=NEW.organization_id AND e.id=NEW.outbox_event_id AND e.type='guest_hub.profile_submitted'
  AND e.payload=jsonb_build_object('revisionId',NEW.id::text,'linkId',NEW.link_id::text,'reservationId',NEW.reservation_id::text)
  AND e.idempotency_key='guest-hub-profile:'||NEW.link_id::text||':'||NEW.command_key::text AND e.occurred_at=NEW.created_at AND e.status='PENDING' AND e.attempt_count=0 AND e.xmin::text=pg_current_xact_id()::xid::text)
  OR NOT EXISTS(SELECT 1 FROM audit_log a WHERE a.organization_id=NEW.organization_id AND a.actor_id IS NULL AND a.action='guest_hub.profile_submitted' AND a.resource_type='guest_hub_profile'
   AND a.resource_id=NEW.id AND a.property_scope_id=NEW.property_id AND a.request_id=NEW.request_id AND a.occurred_at=NEW.created_at
   AND a.after=jsonb_build_object('revisionId',NEW.id::text,'linkId',NEW.link_id::text,'reservationId',NEW.reservation_id::text,'grantId',NEW.grant_id::text,'payloadSha256',NEW.payload_sha256,'outboxEventId',NEW.outbox_event_id::text)
   AND a.xmin::text=pg_current_xact_id()::xid::text)
 THEN RAISE EXCEPTION 'guest_profile_requires_exact_atomic_metadata_event_and_audit';END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER guest_profile_birth_guard AFTER INSERT ON guest_hub_profile_revision DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app_guard_guest_profile_birth();

CREATE FUNCTION app_guard_guest_profile_event_source() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD.type NOT IN('guest_hub.form_grant_recorded','guest_hub.profile_submitted') THEN RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;END IF;
 IF TG_OP='DELETE' OR ROW(OLD.id,OLD.organization_id,OLD.type,OLD.payload,OLD.idempotency_key,OLD.occurred_at) IS DISTINCT FROM ROW(NEW.id,NEW.organization_id,NEW.type,NEW.payload,NEW.idempotency_key,NEW.occurred_at)
 THEN RAISE EXCEPTION 'guest_profile_original_event_source_immutable';END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER guest_profile_event_source_guard BEFORE UPDATE OR DELETE ON outbox_event FOR EACH ROW EXECUTE FUNCTION app_guard_guest_profile_event_source();
CREATE FUNCTION app_guard_guest_profile_event_birth() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
 IF NEW.type='guest_hub.form_grant_recorded' AND NOT EXISTS(SELECT 1 FROM guest_hub_form_grant g WHERE g.organization_id=NEW.organization_id AND g.outbox_event_id=NEW.id AND g.xmin::text=pg_current_xact_id()::xid::text)
  OR NEW.type='guest_hub.profile_submitted' AND NOT EXISTS(SELECT 1 FROM guest_hub_profile_revision r WHERE r.organization_id=NEW.organization_id AND r.outbox_event_id=NEW.id AND r.xmin::text=pg_current_xact_id()::xid::text)
 THEN RAISE EXCEPTION 'guest_profile_event_requires_actual_atomic_native_history';END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER guest_profile_event_birth_guard AFTER INSERT ON outbox_event DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app_guard_guest_profile_event_birth();

COMMIT;
