BEGIN;
-- CreateTable
CREATE TABLE "guest_hub_link" (
    "id" UUID NOT NULL DEFAULT app_uuid_v7(),
    "organization_id" UUID NOT NULL,
    "reservation_id" UUID NOT NULL,
    "property_id" UUID NOT NULL,
    "guest_id" UUID NOT NULL,
    "command_key" UUID NOT NULL,
    "command_hash" TEXT NOT NULL,
    "review_fingerprint" TEXT NOT NULL,
    "source_fingerprint" TEXT NOT NULL,
    "source_snapshot" JSONB NOT NULL,
    "token_hash" TEXT NOT NULL,
    "encrypted_payload" BYTEA NOT NULL,
    "payload_sha256" TEXT NOT NULL,
    "payload_schema" INTEGER NOT NULL DEFAULT 1,
    "policy_id" UUID NOT NULL,
    "policy_version" INTEGER NOT NULL,
    "policy_fingerprint" TEXT NOT NULL,
    "policy_snapshot" JSONB NOT NULL,
    "authorization_cap" JSONB NOT NULL,
    "outbox_event_id" UUID NOT NULL,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "request_id" TEXT NOT NULL,

    CONSTRAINT "guest_hub_link_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "guest_hub_link_revocation" (
    "id" UUID NOT NULL DEFAULT app_uuid_v7(),
    "organization_id" UUID NOT NULL,
    "link_id" UUID NOT NULL,
    "command_key" UUID NOT NULL,
    "command_hash" TEXT NOT NULL,
    "review_fingerprint" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "outbox_event_id" UUID NOT NULL,
    "authorization_cap" JSONB NOT NULL,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL,
    "request_id" TEXT NOT NULL,

    CONSTRAINT "guest_hub_link_revocation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "guest_hub_link_reservation_history_idx" ON "guest_hub_link"("organization_id", "reservation_id", "created_at", "id");

-- CreateIndex
CREATE INDEX "guest_hub_link_issuer_history_idx" ON "guest_hub_link"("organization_id", "created_by", "created_at", "id");

-- CreateIndex
CREATE UNIQUE INDEX "guest_hub_link_org_id_key" ON "guest_hub_link"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "guest_hub_link_nonce_key" ON "guest_hub_link"("organization_id", "command_key");

-- CreateIndex
CREATE UNIQUE INDEX "guest_hub_link_token_key" ON "guest_hub_link"("organization_id", "token_hash");

-- CreateIndex
CREATE UNIQUE INDEX "guest_hub_link_outbox_key" ON "guest_hub_link"("organization_id", "outbox_event_id");

-- CreateIndex
CREATE UNIQUE INDEX "guest_hub_revocation_org_id_key" ON "guest_hub_link_revocation"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "guest_hub_revocation_final_key" ON "guest_hub_link_revocation"("organization_id", "link_id");

-- CreateIndex
CREATE UNIQUE INDEX "guest_hub_revocation_nonce_key" ON "guest_hub_link_revocation"("organization_id", "command_key");

-- CreateIndex
CREATE UNIQUE INDEX "guest_hub_revocation_outbox_key" ON "guest_hub_link_revocation"("organization_id", "outbox_event_id");

-- AddForeignKey
ALTER TABLE "guest_hub_link" ADD CONSTRAINT "guest_hub_link_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "guest_hub_link" ADD CONSTRAINT "guest_hub_link_organization_id_reservation_id_fkey" FOREIGN KEY ("organization_id", "reservation_id") REFERENCES "reservation"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "guest_hub_link" ADD CONSTRAINT "guest_hub_link_organization_id_property_id_fkey" FOREIGN KEY ("organization_id", "property_id") REFERENCES "property"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "guest_hub_link" ADD CONSTRAINT "guest_hub_link_organization_id_guest_id_fkey" FOREIGN KEY ("organization_id", "guest_id") REFERENCES "guest"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "guest_hub_link" ADD CONSTRAINT "guest_hub_link_organization_id_created_by_fkey" FOREIGN KEY ("organization_id", "created_by") REFERENCES "user_account"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "guest_hub_link" ADD CONSTRAINT "guest_hub_link_organization_id_policy_id_fkey" FOREIGN KEY ("organization_id", "policy_id") REFERENCES "config_rule"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "guest_hub_link" ADD CONSTRAINT "guest_hub_link_organization_id_outbox_event_id_fkey" FOREIGN KEY ("organization_id", "outbox_event_id") REFERENCES "outbox_event"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "guest_hub_link_revocation" ADD CONSTRAINT "guest_hub_link_revocation_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "guest_hub_link_revocation" ADD CONSTRAINT "guest_hub_link_revocation_organization_id_link_id_fkey" FOREIGN KEY ("organization_id", "link_id") REFERENCES "guest_hub_link"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "guest_hub_link_revocation" ADD CONSTRAINT "guest_hub_link_revocation_organization_id_created_by_fkey" FOREIGN KEY ("organization_id", "created_by") REFERENCES "user_account"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "guest_hub_link_revocation" ADD CONSTRAINT "guest_hub_link_revocation_organization_id_outbox_event_id_fkey" FOREIGN KEY ("organization_id", "outbox_event_id") REFERENCES "outbox_event"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;


ALTER TABLE guest_hub_link ENABLE ROW LEVEL SECURITY;
ALTER TABLE guest_hub_link FORCE ROW LEVEL SECURITY;
CREATE POLICY guest_hub_link_tenant_isolation ON guest_hub_link
 USING(organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid)
 WITH CHECK(organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid);
ALTER TABLE guest_hub_link_revocation ENABLE ROW LEVEL SECURITY;
ALTER TABLE guest_hub_link_revocation FORCE ROW LEVEL SECURITY;
CREATE POLICY guest_hub_revocation_tenant_isolation ON guest_hub_link_revocation
 USING(organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid)
 WITH CHECK(organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid);
CREATE TRIGGER guest_hub_link_immutable BEFORE UPDATE OR DELETE ON guest_hub_link FOR EACH ROW EXECUTE FUNCTION app_onboarding_append_only();
CREATE TRIGGER guest_hub_revocation_immutable BEFORE UPDATE OR DELETE ON guest_hub_link_revocation FOR EACH ROW EXECUTE FUNCTION app_onboarding_append_only();

ALTER TABLE guest_hub_link ADD CONSTRAINT guest_hub_link_shape CHECK(coalesce(
 isfinite(created_at) AND isfinite(expires_at) AND expires_at>created_at AND payload_schema=1 AND policy_version>0
 AND octet_length(encrypted_payload) BETWEEN 64 AND 16384 AND payload_sha256=encode(sha256(encrypted_payload),'hex')
 AND token_hash ~ '^[a-f0-9]{64}$' AND command_hash ~ '^[a-f0-9]{64}$' AND review_fingerprint ~ '^[a-f0-9]{64}$'
 AND source_fingerprint ~ '^[a-f0-9]{64}$' AND policy_fingerprint ~ '^[a-f0-9]{64}$' AND length(request_id) BETWEEN 1 AND 200
 AND created_at=date_trunc('milliseconds',created_at) AND expires_at=date_trunc('milliseconds',expires_at)
 AND jsonb_typeof(source_snapshot)='object' AND source_snapshot->>'protocol'='NATIVE_GUEST_LINK_SOURCE_V1'
 AND source_snapshot->>'organizationId'=organization_id::text AND source_snapshot->>'reservationId'=reservation_id::text
 AND source_snapshot->>'propertyId'=property_id::text AND source_snapshot->>'guestId'=guest_id::text
 AND source_snapshot-ARRAY['protocol','organizationId','reservationId','propertyId','guestId','reservationVersion','reservationTuple','reservationNumber','propertyVersion','propertyTuple','guestVersion','guestTuple','checkOut','timezone']='{}'::jsonb
 AND jsonb_typeof(policy_snapshot)='object' AND policy_snapshot->>'id'=policy_id::text AND policy_snapshot->>'version'=policy_version::text
 AND policy_snapshot-ARRAY['id','version','value']='{}'::jsonb AND jsonb_typeof(policy_snapshot->'value')='object'
 AND jsonb_typeof(authorization_cap)='object' AND authorization_cap->>'schemaVersion'='1'
 AND authorization_cap->>'organizationId'=organization_id::text AND authorization_cap->>'userAccountId'=created_by::text
 ,false));
ALTER TABLE guest_hub_link_revocation ADD CONSTRAINT guest_hub_revocation_shape CHECK(coalesce(
 isfinite(created_at) AND created_at=date_trunc('milliseconds',created_at) AND length(btrim(reason)) BETWEEN 1 AND 1000
 AND command_hash ~ '^[a-f0-9]{64}$' AND review_fingerprint ~ '^[a-f0-9]{64}$' AND length(request_id) BETWEEN 1 AND 200
 AND jsonb_typeof(authorization_cap)='object' AND authorization_cap->>'schemaVersion'='1'
 AND authorization_cap->>'organizationId'=organization_id::text AND authorization_cap->>'userAccountId'=created_by::text
 ,false));

CREATE FUNCTION app_guard_guest_hub_link_native() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE r reservation%ROWTYPE;p property%ROWTYPE;g guest%ROWTYPE;policy config_rule%ROWTYPE;rv TEXT;rt TEXT;pv TEXT;pt TEXT;gv TEXT;gt TEXT;expected_expiry TIMESTAMPTZ;
BEGIN
 SELECT * INTO r FROM reservation WHERE organization_id=NEW.organization_id AND id=NEW.reservation_id FOR SHARE;
 SELECT * INTO p FROM property WHERE organization_id=NEW.organization_id AND id=NEW.property_id FOR SHARE;
 SELECT * INTO g FROM guest WHERE organization_id=NEW.organization_id AND id=NEW.guest_id FOR SHARE;
 SELECT * INTO policy FROM config_rule WHERE organization_id=NEW.organization_id AND id=NEW.policy_id FOR SHARE;
 SELECT xmin::text,ctid::text INTO rv,rt FROM reservation WHERE organization_id=NEW.organization_id AND id=NEW.reservation_id;
 SELECT xmin::text,ctid::text INTO pv,pt FROM property WHERE organization_id=NEW.organization_id AND id=NEW.property_id;
 SELECT xmin::text,ctid::text INTO gv,gt FROM guest WHERE organization_id=NEW.organization_id AND id=NEW.guest_id;
 IF NOT coalesce(r.id IS NOT NULL AND p.id IS NOT NULL AND g.id IS NOT NULL AND policy.id IS NOT NULL
  AND r.property_id=p.id AND r.guest_id=g.id AND r.archived_at IS NULL AND p.archived_at IS NULL AND g.archived_at IS NULL AND g.merged_into_id IS NULL
  AND NEW.created_at<=clock_timestamp() AND policy.created_by IS NOT NULL AND policy.key='guest_hub.links' AND policy.lifecycle='ACTIVE'
  AND policy.version=NEW.policy_version AND policy.value=NEW.policy_snapshot->'value' AND policy.effective_from<=NEW.created_at
  AND (policy.effective_to IS NULL OR policy.effective_to>NEW.created_at)
  AND (policy.scope_type='organization' AND policy.scope_id IS NULL OR policy.scope_type='property' AND policy.scope_id=p.id OR policy.scope_type='city' AND policy.scope_id=p.city_id)
  AND policy.value->>'source'='NATIVE_RESERVATION_GUEST_LINKS' AND policy.value->>'enabled'='true'
  AND policy.value->>'signature'='PURPOSE_BOUND_VERSIONED_KEY_RING' AND policy.value->>'history'='APPEND_ONLY_GUEST_LINK_HISTORY'
  AND length(btrim(policy.value->>'processing_approval_reference')) BETWEEN 1 AND 1000
  AND jsonb_typeof(policy.value->'allowed_reservation_states')='array' AND policy.value->'allowed_reservation_states' ? r.status
  AND policy.value->>'checkout_local_time' ~ '^(?:[01][0-9]|2[0-3]):[0-5][0-9]$'
  AND policy.value->>'checkout_grace_seconds' ~ '^(0|[1-9][0-9]*)$'
  AND NEW.source_snapshot->>'reservationVersion'=rv AND NEW.source_snapshot->>'reservationTuple'=rt
  AND NEW.source_snapshot->>'reservationNumber'=r.version::text AND NEW.source_snapshot->>'propertyVersion'=pv AND NEW.source_snapshot->>'propertyTuple'=pt
  AND NEW.source_snapshot->>'guestVersion'=gv AND NEW.source_snapshot->>'guestTuple'=gt
  AND NEW.source_snapshot->>'checkOut'=r.check_out::text AND NEW.source_snapshot->>'timezone'=p.timezone,false)
 THEN RAISE EXCEPTION 'guest_hub_link_requires_actual_eligible_source_and_approved_policy';END IF;
 expected_expiry:=(r.check_out::text||' '||(policy.value->>'checkout_local_time'))::timestamp AT TIME ZONE p.timezone;
 expected_expiry:=expected_expiry+((policy.value->>'checkout_grace_seconds')||' seconds')::interval;
 IF NOT coalesce(isfinite(expected_expiry) AND NEW.expires_at=expected_expiry,false) THEN RAISE EXCEPTION 'guest_hub_link_requires_original_configured_expiry';END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER guest_hub_link_native_guard BEFORE INSERT ON guest_hub_link FOR EACH ROW EXECUTE FUNCTION app_guard_guest_hub_link_native();

CREATE FUNCTION app_guard_guest_hub_link_birth() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM outbox_event e WHERE e.organization_id=NEW.organization_id AND e.id=NEW.outbox_event_id AND e.type='guest_hub.link_issued'
  AND e.payload=jsonb_build_object('linkId',NEW.id::text,'reservationId',NEW.reservation_id::text) AND e.idempotency_key='guest-hub-issued:'||NEW.created_by::text||':'||NEW.command_key::text
  AND e.occurred_at=NEW.created_at AND e.status='PENDING' AND e.attempt_count=0 AND e.xmin::text=pg_current_xact_id()::xid::text)
  OR NOT EXISTS(SELECT 1 FROM audit_log a WHERE a.organization_id=NEW.organization_id AND a.actor_id=NEW.created_by AND a.action='guest_hub.link_issued' AND a.resource_type='guest_hub'
   AND a.resource_id=NEW.id AND a.property_scope_id=NEW.property_id AND a.request_id=NEW.request_id AND a.occurred_at=NEW.created_at
   AND a.after=jsonb_build_object('linkId',NEW.id::text,'reservationId',NEW.reservation_id::text,'commandHash',NEW.command_hash,'payloadSha256',NEW.payload_sha256,'sourceFingerprint',NEW.source_fingerprint,'outboxEventId',NEW.outbox_event_id::text)
   AND a.xmin::text=pg_current_xact_id()::xid::text)
 THEN RAISE EXCEPTION 'guest_hub_link_requires_exact_atomic_metadata_event_and_audit';END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER guest_hub_link_birth_guard AFTER INSERT ON guest_hub_link DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app_guard_guest_hub_link_birth();

CREATE FUNCTION app_guard_guest_hub_revocation_birth() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE original guest_hub_link%ROWTYPE;
BEGIN
 SELECT * INTO original FROM guest_hub_link WHERE organization_id=NEW.organization_id AND id=NEW.link_id;
 IF original.id IS NULL OR NEW.created_at<original.created_at OR NEW.created_at>clock_timestamp()
  OR NOT EXISTS(SELECT 1 FROM outbox_event e WHERE e.organization_id=NEW.organization_id AND e.id=NEW.outbox_event_id AND e.type='guest_hub.link_revoked'
   AND e.payload=jsonb_build_object('linkId',NEW.link_id::text,'revocationId',NEW.id::text) AND e.idempotency_key='guest-hub-revoked:'||NEW.created_by::text||':'||NEW.command_key::text
   AND e.occurred_at=NEW.created_at AND e.status='PENDING' AND e.attempt_count=0 AND e.xmin::text=pg_current_xact_id()::xid::text)
  OR NOT EXISTS(SELECT 1 FROM audit_log a WHERE a.organization_id=NEW.organization_id AND a.actor_id=NEW.created_by AND a.action='guest_hub.link_revoked' AND a.resource_type='guest_hub'
   AND a.resource_id=NEW.link_id AND a.property_scope_id=original.property_id AND a.request_id=NEW.request_id AND a.occurred_at=NEW.created_at AND a.reason=NEW.reason
   AND a.after=jsonb_build_object('linkId',NEW.link_id::text,'revocationId',NEW.id::text,'commandHash',NEW.command_hash,'outboxEventId',NEW.outbox_event_id::text)
   AND a.xmin::text=pg_current_xact_id()::xid::text)
 THEN RAISE EXCEPTION 'guest_hub_revocation_requires_original_and_exact_atomic_metadata_event_and_audit';END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER guest_hub_revocation_birth_guard AFTER INSERT ON guest_hub_link_revocation DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app_guard_guest_hub_revocation_birth();

CREATE FUNCTION app_guard_guest_hub_event_source() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD.type NOT IN('guest_hub.link_issued','guest_hub.link_revoked') THEN RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;END IF;
 IF TG_OP='DELETE' OR ROW(OLD.id,OLD.organization_id,OLD.type,OLD.payload,OLD.idempotency_key,OLD.occurred_at) IS DISTINCT FROM ROW(NEW.id,NEW.organization_id,NEW.type,NEW.payload,NEW.idempotency_key,NEW.occurred_at)
 THEN RAISE EXCEPTION 'guest_hub_original_event_source_immutable';END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER guest_hub_event_source_guard BEFORE UPDATE OR DELETE ON outbox_event FOR EACH ROW EXECUTE FUNCTION app_guard_guest_hub_event_source();

CREATE FUNCTION app_guard_guest_hub_event_birth() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
 IF NEW.type='guest_hub.link_issued' AND NOT EXISTS(SELECT 1 FROM guest_hub_link l WHERE l.organization_id=NEW.organization_id AND l.outbox_event_id=NEW.id AND l.xmin::text=pg_current_xact_id()::xid::text)
  OR NEW.type='guest_hub.link_revoked' AND NOT EXISTS(SELECT 1 FROM guest_hub_link_revocation r WHERE r.organization_id=NEW.organization_id AND r.outbox_event_id=NEW.id AND r.xmin::text=pg_current_xact_id()::xid::text)
 THEN RAISE EXCEPTION 'guest_hub_event_requires_actual_atomic_native_history';END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER guest_hub_event_birth_guard AFTER INSERT ON outbox_event DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app_guard_guest_hub_event_birth();

COMMIT;
