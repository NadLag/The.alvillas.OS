BEGIN;
-- Native private capture intents and file identities; encrypted bytes remain in the canonical archive.
CREATE TABLE "guest_hub_identity_document_capture" (
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
    "form_fingerprint" TEXT NOT NULL,
    "manifest_fingerprint" TEXT NOT NULL,
    "file_manifest" JSONB NOT NULL,
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

    CONSTRAINT "guest_hub_identity_document_capture_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "guest_identity_capture_link_history_idx" ON "guest_hub_identity_document_capture"("organization_id", "link_id", "created_at", "id");
CREATE UNIQUE INDEX "guest_identity_capture_org_id_key" ON "guest_hub_identity_document_capture"("organization_id", "id");
CREATE UNIQUE INDEX "guest_identity_capture_nonce_key" ON "guest_hub_identity_document_capture"("organization_id", "link_id", "command_key");
CREATE UNIQUE INDEX "guest_identity_capture_version_key" ON "guest_hub_identity_document_capture"("organization_id", "reservation_id", "guest_id", "version");
CREATE UNIQUE INDEX "guest_identity_capture_predecessor_key" ON "guest_hub_identity_document_capture"("organization_id", "previous_id");
CREATE UNIQUE INDEX "guest_identity_capture_outbox_key" ON "guest_hub_identity_document_capture"("organization_id", "outbox_event_id");
ALTER TABLE "guest_hub_identity_document_capture" ADD CONSTRAINT "guest_identity_capture_organization_fk" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE "guest_hub_identity_document_capture" ADD CONSTRAINT "guest_identity_capture_link_fk" FOREIGN KEY ("organization_id", "link_id") REFERENCES "guest_hub_link"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE "guest_hub_identity_document_capture" ADD CONSTRAINT "guest_identity_capture_grant_fk" FOREIGN KEY ("organization_id", "grant_id") REFERENCES "guest_hub_form_grant"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE "guest_hub_identity_document_capture" ADD CONSTRAINT "guest_identity_capture_reservation_fk" FOREIGN KEY ("organization_id", "reservation_id") REFERENCES "reservation"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE "guest_hub_identity_document_capture" ADD CONSTRAINT "guest_identity_capture_property_fk" FOREIGN KEY ("organization_id", "property_id") REFERENCES "property"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE "guest_hub_identity_document_capture" ADD CONSTRAINT "guest_identity_capture_guest_fk" FOREIGN KEY ("organization_id", "guest_id") REFERENCES "guest"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE "guest_hub_identity_document_capture" ADD CONSTRAINT "guest_identity_capture_policy_fk" FOREIGN KEY ("organization_id", "policy_id") REFERENCES "config_rule"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE "guest_hub_identity_document_capture" ADD CONSTRAINT "guest_identity_capture_outbox_fk" FOREIGN KEY ("organization_id", "outbox_event_id") REFERENCES "outbox_event"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE "guest_hub_identity_document_capture" ADD CONSTRAINT "guest_identity_capture_previous_fk" FOREIGN KEY ("organization_id", "previous_id") REFERENCES "guest_hub_identity_document_capture"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE guest_hub_identity_document_capture ENABLE ROW LEVEL SECURITY;
ALTER TABLE guest_hub_identity_document_capture FORCE ROW LEVEL SECURITY;
CREATE POLICY guest_hub_identity_document_capture_tenant_isolation ON guest_hub_identity_document_capture
 USING(organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid)
 WITH CHECK(organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid);
CREATE TRIGGER guest_identity_capture_immutable BEFORE UPDATE OR DELETE ON guest_hub_identity_document_capture FOR EACH ROW EXECUTE FUNCTION app_onboarding_append_only();
ALTER TABLE guest_hub_identity_document_capture ADD CONSTRAINT guest_identity_capture_shape CHECK(coalesce(
 version>0 AND ((version=1)=(previous_id IS NULL)) AND payload_schema=1 AND policy_version>0
 AND isfinite(created_at) AND created_at=date_trunc('milliseconds',created_at) AND length(request_id) BETWEEN 1 AND 200
 AND command_hash ~ '^[a-f0-9]{64}$' AND length(command_key_version) BETWEEN 1 AND 120
 AND grant_fingerprint ~ '^[a-f0-9]{64}$' AND form_fingerprint ~ '^[a-f0-9]{64}$' AND manifest_fingerprint ~ '^[a-f0-9]{64}$'
 AND policy_fingerprint ~ '^[a-f0-9]{64}$' AND source_fingerprint ~ '^[a-f0-9]{64}$'
 AND octet_length(encrypted_payload) BETWEEN 64 AND 65536 AND payload_sha256=encode(sha256(encrypted_payload),'hex')
 AND jsonb_typeof(source_snapshot)='object' AND jsonb_typeof(policy_snapshot)='object'
 AND policy_snapshot->>'id'=policy_id::text AND policy_snapshot->>'version'=policy_version::text
 AND policy_snapshot-ARRAY['id','version','value']='{}'::jsonb AND jsonb_typeof(policy_snapshot->'value')='object'
 AND jsonb_typeof(file_manifest)='array' AND jsonb_array_length(file_manifest) BETWEEN 1 AND 6
 ,false));

CREATE TABLE guest_hub_identity_document_file (
 id UUID PRIMARY KEY,
 organization_id UUID NOT NULL,
 capture_id UUID NOT NULL,
 kind TEXT NOT NULL,
 part TEXT NOT NULL,
 created_at TIMESTAMPTZ(6) NOT NULL,
 CONSTRAINT guest_identity_file_organization_fk FOREIGN KEY(organization_id) REFERENCES organization(id) ON DELETE RESTRICT ON UPDATE NO ACTION,
 CONSTRAINT guest_identity_file_capture_fk FOREIGN KEY(organization_id,capture_id) REFERENCES guest_hub_identity_document_capture(organization_id,id) ON DELETE RESTRICT ON UPDATE NO ACTION,
 CONSTRAINT guest_identity_file_shape CHECK(kind IN('PASSPORT','NATIONAL_ID') AND part IN('IDENTITY_PAGE','FRONT','BACK') AND isfinite(created_at) AND created_at=date_trunc('milliseconds',created_at))
);
CREATE UNIQUE INDEX guest_identity_file_org_id_key ON guest_hub_identity_document_file(organization_id,id);
CREATE UNIQUE INDEX guest_identity_file_side_key ON guest_hub_identity_document_file(organization_id,capture_id,kind,part);
ALTER TABLE guest_hub_identity_document_file ENABLE ROW LEVEL SECURITY;
ALTER TABLE guest_hub_identity_document_file FORCE ROW LEVEL SECURITY;
CREATE POLICY guest_hub_identity_document_file_tenant_isolation ON guest_hub_identity_document_file
 USING(organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid)
 WITH CHECK(organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid);
CREATE TRIGGER guest_identity_file_immutable BEFORE UPDATE OR DELETE ON guest_hub_identity_document_file FOR EACH ROW EXECUTE FUNCTION app_onboarding_append_only();

CREATE FUNCTION app_guard_guest_identity_capture_native() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE original guest_hub_link%ROWTYPE;grant_row guest_hub_form_grant%ROWTYPE;head guest_hub_identity_document_capture%ROWTYPE;item JSONB;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('guest-hub-link:'||NEW.organization_id::text||':'||NEW.link_id::text,0));
 PERFORM pg_advisory_xact_lock(hashtextextended('guest-hub-identity-documents:'||NEW.organization_id::text||':'||NEW.reservation_id::text||':'||NEW.guest_id::text,0));
 SELECT * INTO original FROM guest_hub_link WHERE organization_id=NEW.organization_id AND id=NEW.link_id;
 SELECT * INTO grant_row FROM guest_hub_form_grant WHERE organization_id=NEW.organization_id AND link_id=NEW.link_id AND form_key='IDENTITY_DOCUMENTS' ORDER BY version DESC LIMIT 1;
 SELECT * INTO head FROM guest_hub_identity_document_capture WHERE organization_id=NEW.organization_id AND reservation_id=NEW.reservation_id AND guest_id=NEW.guest_id ORDER BY version DESC LIMIT 1;
 IF NOT coalesce(original.id IS NOT NULL AND NEW.grant_id=grant_row.id AND grant_row.decision='GRANTED' AND grant_row.link_token_hash=original.token_hash
  AND NEW.reservation_id=original.reservation_id AND NEW.property_id=original.property_id AND NEW.guest_id=original.guest_id
  AND grant_row.reservation_id=NEW.reservation_id AND grant_row.property_id=NEW.property_id AND grant_row.guest_id=NEW.guest_id
  AND NEW.created_at>=grant_row.created_at AND NEW.created_at<grant_row.expires_at AND NEW.created_at<original.expires_at AND NEW.created_at<=clock_timestamp()
  AND NOT EXISTS(SELECT 1 FROM guest_hub_link_revocation WHERE organization_id=NEW.organization_id AND link_id=NEW.link_id)
  AND EXISTS(SELECT 1 FROM guest_hub_identity_document_delegation WHERE organization_id=NEW.organization_id AND grant_id=NEW.grant_id)
  AND (head.id IS NULL AND NEW.version=1 AND NEW.previous_id IS NULL OR head.id=NEW.previous_id AND NEW.version=head.version+1 AND NEW.created_at>=head.created_at)
  AND NEW.version<=least((grant_row.policy_snapshot->'value'->>'max_captures')::integer,(NEW.policy_snapshot->'value'->>'max_captures')::integer)
  AND app_guest_profile_actual_source(NEW.organization_id,NEW.reservation_id,NEW.property_id,NEW.guest_id,NEW.source_snapshot)
  AND app_guest_form_actual_policy(NEW.organization_id,NEW.policy_id,NEW.policy_version,NEW.policy_snapshot,NEW.reservation_id,NEW.property_id,NEW.created_at,'IDENTITY_DOCUMENTS'),false)
 THEN RAISE EXCEPTION 'guest_identity_capture_requires_actual_source_live_delegation_policy_and_exact_predecessor';END IF;
 FOR item IN SELECT value FROM jsonb_array_elements(NEW.file_manifest) LOOP
  IF NOT coalesce(jsonb_typeof(item)='object' AND item-ARRAY['id','kind','part']='{}'::jsonb
   AND item->>'id' ~ '^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'
   AND item->>'kind' IN('PASSPORT','NATIONAL_ID') AND item->>'part' IN('IDENTITY_PAGE','FRONT','BACK'),false)
  THEN RAISE EXCEPTION 'guest_identity_capture_requires_closed_file_manifest';END IF;
 END LOOP;
 IF (SELECT count(DISTINCT value->>'id') FROM jsonb_array_elements(NEW.file_manifest))<>jsonb_array_length(NEW.file_manifest)
  OR (SELECT count(DISTINCT (value->>'kind',value->>'part')) FROM jsonb_array_elements(NEW.file_manifest))<>jsonb_array_length(NEW.file_manifest)
 THEN RAISE EXCEPTION 'guest_identity_capture_requires_distinct_file_identities_and_sides';END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER guest_identity_capture_native_guard BEFORE INSERT ON guest_hub_identity_document_capture FOR EACH ROW EXECUTE FUNCTION app_guard_guest_identity_capture_native();

CREATE FUNCTION app_guard_guest_identity_file_native() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE original RECORD;
BEGIN
 SELECT c.*,c.xmin::text AS native_xmin INTO original FROM guest_hub_identity_document_capture c WHERE c.organization_id=NEW.organization_id AND c.id=NEW.capture_id FOR SHARE OF c;
 IF NOT coalesce(original.id IS NOT NULL AND original.native_xmin=pg_current_xact_id()::xid::text AND NEW.created_at=original.created_at
  AND original.file_manifest @> jsonb_build_array(jsonb_build_object('id',NEW.id::text,'kind',NEW.kind,'part',NEW.part)),false)
 THEN RAISE EXCEPTION 'guest_identity_file_requires_exact_atomic_original_capture_manifest';END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER guest_identity_file_native_guard BEFORE INSERT ON guest_hub_identity_document_file FOR EACH ROW EXECUTE FUNCTION app_guard_guest_identity_file_native();

CREATE FUNCTION app_guard_guest_identity_capture_birth() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM outbox_event e WHERE e.organization_id=NEW.organization_id AND e.id=NEW.outbox_event_id AND e.type='guest_hub.identity_capture_recorded'
  AND e.payload=jsonb_build_object('captureId',NEW.id::text,'linkId',NEW.link_id::text,'reservationId',NEW.reservation_id::text)
  AND e.idempotency_key='guest-hub-identity-capture:'||NEW.link_id::text||':'||NEW.command_key::text AND e.occurred_at=NEW.created_at AND e.status='PENDING' AND e.attempt_count=0 AND e.xmin::text=pg_current_xact_id()::xid::text)
  OR NOT EXISTS(SELECT 1 FROM audit_log a WHERE a.organization_id=NEW.organization_id AND a.actor_id IS NULL AND a.action='guest_hub.identity_capture_recorded' AND a.resource_type='guest_hub_identity_documents'
   AND a.resource_id=NEW.id AND a.property_scope_id=NEW.property_id AND a.request_id=NEW.request_id AND a.occurred_at=NEW.created_at
   AND a.after=jsonb_build_object('captureId',NEW.id::text,'linkId',NEW.link_id::text,'reservationId',NEW.reservation_id::text,'grantId',NEW.grant_id::text,'manifestFingerprint',NEW.manifest_fingerprint,'payloadSha256',NEW.payload_sha256,'outboxEventId',NEW.outbox_event_id::text)
   AND a.xmin::text=pg_current_xact_id()::xid::text)
  OR (SELECT count(*) FROM guest_hub_identity_document_file f WHERE f.organization_id=NEW.organization_id AND f.capture_id=NEW.id AND f.xmin::text=pg_current_xact_id()::xid::text)<>jsonb_array_length(NEW.file_manifest)
 THEN RAISE EXCEPTION 'guest_identity_capture_requires_exact_atomic_files_metadata_event_and_audit';END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER guest_identity_capture_birth_guard AFTER INSERT ON guest_hub_identity_document_capture DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app_guard_guest_identity_capture_birth();

CREATE FUNCTION app_guard_guest_identity_capture_event_source() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
 IF TG_OP='DELETE' THEN
  IF OLD.type='guest_hub.identity_capture_recorded' THEN RAISE EXCEPTION 'guest_identity_capture_original_event_source_immutable';END IF;
  RETURN OLD;
 END IF;
 IF (OLD.type='guest_hub.identity_capture_recorded' OR NEW.type='guest_hub.identity_capture_recorded') AND
  ROW(OLD.id,OLD.organization_id,OLD.type,OLD.payload,OLD.idempotency_key,OLD.occurred_at) IS DISTINCT FROM ROW(NEW.id,NEW.organization_id,NEW.type,NEW.payload,NEW.idempotency_key,NEW.occurred_at)
 THEN RAISE EXCEPTION 'guest_identity_capture_original_event_source_immutable';END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER guest_identity_capture_event_source_guard BEFORE UPDATE OR DELETE ON outbox_event FOR EACH ROW EXECUTE FUNCTION app_guard_guest_identity_capture_event_source();
CREATE FUNCTION app_guard_guest_identity_capture_event_birth() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
 IF NEW.type='guest_hub.identity_capture_recorded' AND NOT EXISTS(SELECT 1 FROM guest_hub_identity_document_capture c WHERE c.organization_id=NEW.organization_id AND c.outbox_event_id=NEW.id AND c.xmin::text=pg_current_xact_id()::xid::text)
 THEN RAISE EXCEPTION 'guest_identity_capture_event_requires_actual_atomic_native_capture';END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER guest_identity_capture_event_birth_guard AFTER INSERT ON outbox_event DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app_guard_guest_identity_capture_event_birth();
COMMIT;
