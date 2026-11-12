BEGIN;
-- CreateTable
CREATE TABLE "owner_onboarding_delivery" (
    "id" UUID NOT NULL DEFAULT app_uuid_v7(),
    "organization_id" UUID NOT NULL,
    "package_id" UUID NOT NULL,
    "owner_id" UUID NOT NULL,
    "property_id" UUID NOT NULL,
    "command_key" UUID NOT NULL,
    "command_hash" TEXT NOT NULL,
    "review_fingerprint" TEXT NOT NULL,
    "source_fingerprint" TEXT NOT NULL,
    "source_snapshot" JSONB NOT NULL,
    "document_plan" JSONB NOT NULL,
    "email_plan" JSONB NOT NULL,
    "locale" CHAR(2) NOT NULL,
    "recipient_key" TEXT NOT NULL,
    "encrypted_payload" BYTEA NOT NULL,
    "payload_sha256" TEXT NOT NULL,
    "payload_schema" INTEGER NOT NULL DEFAULT 1,
    "policy_id" UUID NOT NULL,
    "policy_version" INTEGER NOT NULL,
    "policy_snapshot" JSONB NOT NULL,
    "authorization_cap" JSONB NOT NULL,
    "outbox_event_id" UUID NOT NULL,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL,
    "request_id" TEXT NOT NULL,

    CONSTRAINT "owner_onboarding_delivery_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "owner_delivery_package_history_idx" ON "owner_onboarding_delivery"("organization_id", "package_id", "created_at", "id");

-- CreateIndex
CREATE INDEX "owner_delivery_property_history_idx" ON "owner_onboarding_delivery"("organization_id", "property_id", "created_at", "id");

-- CreateIndex
CREATE INDEX "owner_delivery_creator_history_idx" ON "owner_onboarding_delivery"("organization_id", "created_by", "created_at", "id");

-- CreateIndex
CREATE UNIQUE INDEX "owner_delivery_org_id_key" ON "owner_onboarding_delivery"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "owner_delivery_nonce_key" ON "owner_onboarding_delivery"("organization_id", "command_key");

-- CreateIndex
CREATE UNIQUE INDEX "owner_delivery_outbox_key" ON "owner_onboarding_delivery"("organization_id", "outbox_event_id");

-- AddForeignKey
ALTER TABLE "owner_onboarding_delivery" ADD CONSTRAINT "owner_onboarding_delivery_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "owner_onboarding_delivery" ADD CONSTRAINT "owner_onboarding_delivery_organization_id_package_id_fkey" FOREIGN KEY ("organization_id", "package_id") REFERENCES "owner_onboarding_package"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "owner_onboarding_delivery" ADD CONSTRAINT "owner_onboarding_delivery_organization_id_owner_id_fkey" FOREIGN KEY ("organization_id", "owner_id") REFERENCES "owner"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "owner_onboarding_delivery" ADD CONSTRAINT "owner_onboarding_delivery_organization_id_property_id_fkey" FOREIGN KEY ("organization_id", "property_id") REFERENCES "property"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "owner_onboarding_delivery" ADD CONSTRAINT "owner_onboarding_delivery_organization_id_created_by_fkey" FOREIGN KEY ("organization_id", "created_by") REFERENCES "user_account"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "owner_onboarding_delivery" ADD CONSTRAINT "owner_onboarding_delivery_organization_id_policy_id_fkey" FOREIGN KEY ("organization_id", "policy_id") REFERENCES "config_rule"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "owner_onboarding_delivery" ADD CONSTRAINT "owner_onboarding_delivery_organization_id_outbox_event_id_fkey" FOREIGN KEY ("organization_id", "outbox_event_id") REFERENCES "outbox_event"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;


ALTER TABLE owner_onboarding_delivery ENABLE ROW LEVEL SECURITY;
ALTER TABLE owner_onboarding_delivery FORCE ROW LEVEL SECURITY;
CREATE POLICY owner_onboarding_delivery_tenant_isolation ON owner_onboarding_delivery
 USING(organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid)
 WITH CHECK(organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid);
CREATE TRIGGER owner_delivery_immutable BEFORE UPDATE OR DELETE ON owner_onboarding_delivery FOR EACH ROW EXECUTE FUNCTION app_onboarding_append_only();

-- Application canonical JSON helpers authenticate the private original. SQL binds actual immutable native identities and lineage.
ALTER TABLE owner_onboarding_delivery ADD CONSTRAINT owner_delivery_shape CHECK(coalesce(
 isfinite(created_at) AND payload_schema=1 AND policy_version>0 AND locale IN('en','fr','ar')
 AND length(request_id) BETWEEN 1 AND 200 AND octet_length(encrypted_payload) BETWEEN 64 AND 1048576
 AND payload_sha256=encode(sha256(encrypted_payload),'hex') AND command_hash ~ '^[a-f0-9]{64}$'
 AND review_fingerprint ~ '^[a-f0-9]{64}$' AND source_fingerprint ~ '^[a-f0-9]{64}$' AND recipient_key ~ '^[a-f0-9]{64}$'
 AND jsonb_typeof(source_snapshot)='object' AND source_snapshot->>'protocol'='NATIVE_OWNER_PACKAGE_EMAIL_V1'
 AND source_snapshot->>'organizationId'=organization_id::text AND source_snapshot->>'packageId'=package_id::text
 AND source_snapshot->>'ownerId'=owner_id::text AND source_snapshot->>'propertyId'=property_id::text
 AND source_snapshot->>'recipientKey'=recipient_key AND source_snapshot->>'ownerLocale'=locale::text
 AND source_snapshot->>'nativePackageFingerprint' ~ '^[a-f0-9]{64}$' AND source_snapshot->>'emailFingerprint' ~ '^[a-f0-9]{64}$'
 AND source_snapshot-ARRAY['protocol','organizationId','packageId','sessionId','reviewRevisionId','ownerId','propertyId','nativePackageFingerprint','ownerVersion','ownerTuple','ownerCreatedAt','ownerUpdatedAt','recipientKey','ownerLocale','emailFingerprint']='{}'::jsonb
 AND jsonb_typeof(document_plan)='array' AND jsonb_array_length(document_plan) BETWEEN 2 AND 3 AND octet_length(document_plan::text)<=65536
 AND jsonb_typeof(email_plan)='array' AND jsonb_array_length(email_plan) BETWEEN 2 AND 3 AND octet_length(email_plan::text)<=65536
 AND jsonb_typeof(policy_snapshot)='object' AND policy_snapshot->>'id'=policy_id::text AND policy_snapshot->>'version'=policy_version::text
 AND jsonb_typeof(authorization_cap)='object' AND authorization_cap->>'schemaVersion'='1'
 AND authorization_cap->>'organizationId'=organization_id::text AND authorization_cap->>'userAccountId'=created_by::text
 AND jsonb_typeof(authorization_cap->'permissions')='array' AND jsonb_typeof(authorization_cap->'scopes')='array',false));

CREATE FUNCTION app_guard_owner_delivery_native() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE package owner_onboarding_package%ROWTYPE;reviewed property_onboarding_revision%ROWTYPE;target property%ROWTYPE;
 owner_row owner%ROWTYPE;owner_version text;owner_tuple text;target_version text;target_tuple text;policy config_rule%ROWTYPE;entry jsonb;
BEGIN
 SELECT p.* INTO package FROM owner_onboarding_package p WHERE p.organization_id=NEW.organization_id AND p.id=NEW.package_id;
 PERFORM pg_advisory_xact_lock(hashtextextended(NEW.organization_id::text||':onboarding:session:'||package.session_id::text,0));
 SELECT r.* INTO reviewed FROM property_onboarding_revision r WHERE r.organization_id=NEW.organization_id AND r.id=package.review_revision_id;
 SELECT p.* INTO target FROM property p WHERE p.organization_id=NEW.organization_id AND p.id=NEW.property_id FOR UPDATE;
 SELECT p.xmin::text,p.ctid::text INTO target_version,target_tuple FROM property p WHERE p.organization_id=NEW.organization_id AND p.id=NEW.property_id;
 SELECT o.* INTO owner_row FROM owner o WHERE o.organization_id=NEW.organization_id AND o.id=NEW.owner_id;
 SELECT o.xmin::text,o.ctid::text INTO owner_version,owner_tuple FROM owner o WHERE o.organization_id=NEW.organization_id AND o.id=NEW.owner_id;
 IF NOT coalesce(package.id IS NOT NULL AND package.owner_id=NEW.owner_id AND package.property_id=NEW.property_id
  AND package.created_by=NEW.created_by AND NEW.created_at>=package.created_at AND owner_row.archived_at IS NULL AND owner_row.email IS NOT NULL
  AND owner_row.preferred_locale=NEW.locale AND NEW.source_snapshot->>'ownerVersion'=owner_version AND NEW.source_snapshot->>'ownerTuple'=owner_tuple
  AND (NEW.source_snapshot->>'ownerCreatedAt')::timestamptz=date_trunc('milliseconds',owner_row.created_at)
  AND (NEW.source_snapshot->>'ownerUpdatedAt')::timestamptz=date_trunc('milliseconds',owner_row.updated_at)
  AND NEW.source_snapshot->>'sessionId'=package.session_id::text AND NEW.source_snapshot->>'reviewRevisionId'=package.review_revision_id::text
  AND NEW.source_snapshot->>'nativePackageFingerprint'=package.source_snapshot->>'nativePackageFingerprint'
  AND reviewed.step='REVIEW' AND reviewed.mode='VALIDATE' AND reviewed.session_id=package.session_id
  AND reviewed.id=(SELECT r.id FROM property_onboarding_revision r WHERE r.organization_id=NEW.organization_id AND r.session_id=package.session_id ORDER BY r.number DESC LIMIT 1)
  AND target.archived_at IS NULL AND target.status IN('DRAFT','ONBOARDING')
  AND reviewed.source_snapshot#>>'{parent,property,xmin}'=target_version AND reviewed.source_snapshot#>>'{parent,property,tuple}'=target_tuple
  AND reviewed.source_snapshot#>>'{parent,owner,ownerXmin}'=owner_version AND reviewed.source_snapshot#>>'{parent,owner,ownerTuple}'=owner_tuple
  AND EXISTS(SELECT 1 FROM property_owner p WHERE p.organization_id=NEW.organization_id AND p.property_id=NEW.property_id AND p.owner_id=NEW.owner_id AND p.archived_at IS NULL),false)
 THEN RAISE EXCEPTION 'owner delivery requires the actual complete native package and unchanged owner recipient'; END IF;
 IF EXISTS(SELECT 1 FROM property_onboarding_revision r WHERE r.organization_id=NEW.organization_id AND r.command_key=NEW.command_key)
  OR EXISTS(SELECT 1 FROM property_onboarding_activation_request r WHERE r.organization_id=NEW.organization_id AND r.command_key=NEW.command_key)
  OR EXISTS(SELECT 1 FROM owner_onboarding_package p WHERE p.organization_id=NEW.organization_id AND p.command_key=NEW.command_key)
 THEN RAISE EXCEPTION 'owner delivery requires its original independent command nonce'; END IF;
 SELECT r.* INTO policy FROM config_rule r WHERE r.organization_id=NEW.organization_id AND r.id=NEW.policy_id;
 IF NOT coalesce(policy.key='onboarding.owner_delivery' AND policy.version=NEW.policy_version AND policy.created_by IS NOT NULL
  AND policy.archived_at IS NULL AND policy.lifecycle='ACTIVE' AND policy.effective_from<=NEW.created_at AND (policy.effective_to IS NULL OR policy.effective_to>NEW.created_at)
  AND NEW.policy_snapshot=jsonb_build_object('id',policy.id,'version',policy.version,'value',policy.value)
  AND policy.value->>'source'='NATIVE_COMPLETED_OWNER_PACKAGE' AND policy.value->>'channel'='EMAIL' AND policy.value->>'template'='NATIVE_OWNER_PACKAGE_EMAIL_V1'
  AND jsonb_typeof(policy.value->'locales')='array' AND jsonb_array_length(policy.value->'locales') BETWEEN 2 AND 3
  AND policy.value->'locales' ? 'en' AND policy.value->'locales' ? 'fr' AND policy.value->'locales' ? NEW.locale::text
  AND CASE policy.scope_type WHEN 'organization' THEN policy.scope_id IS NULL WHEN 'property' THEN policy.scope_id=NEW.property_id
   WHEN 'owner' THEN policy.scope_id=NEW.owner_id WHEN 'city' THEN policy.scope_id=target.city_id
   WHEN 'agreement' THEN policy.scope_id::text=package.source_snapshot->>'agreementId' ELSE false END,false)
 THEN RAISE EXCEPTION 'owner delivery requires its actual approved selected native policy'; END IF;
 IF jsonb_array_length(NEW.document_plan)<>jsonb_array_length(package.document_plan)
  OR jsonb_array_length(NEW.email_plan)<>jsonb_array_length(NEW.document_plan)
  OR jsonb_array_length(NEW.email_plan)<>jsonb_array_length(policy.value->'locales')
  OR (SELECT count(DISTINCT e->>'locale') FROM jsonb_array_elements(NEW.document_plan) e)<>jsonb_array_length(NEW.document_plan)
  OR (SELECT count(DISTINCT e->>'versionId') FROM jsonb_array_elements(NEW.document_plan) e)<>jsonb_array_length(NEW.document_plan)
  OR (SELECT count(DISTINCT e->>'instanceId') FROM jsonb_array_elements(NEW.document_plan) e)<>jsonb_array_length(NEW.document_plan)
  OR (SELECT count(DISTINCT e->>'documentId') FROM jsonb_array_elements(NEW.document_plan) e)<>jsonb_array_length(NEW.document_plan)
  OR (SELECT count(DISTINCT e->>'locale') FROM jsonb_array_elements(NEW.email_plan) e)<>jsonb_array_length(NEW.email_plan)
 THEN RAISE EXCEPTION 'owner delivery requires every distinct original document and email language'; END IF;
 FOR entry IN SELECT value FROM jsonb_array_elements(NEW.document_plan) LOOP
  IF NOT coalesce(jsonb_typeof(entry)='object' AND entry-ARRAY['locale','instanceId','documentId','versionId','sha256','cipherSha256','byteSize','contentType']='{}'::jsonb
   AND entry->>'locale' IN('en','fr','ar') AND policy.value->'locales' ? (entry->>'locale') AND entry->>'contentType'='application/pdf'
   AND EXISTS(SELECT 1 FROM owner_onboarding_package_item item JOIN document_instance i ON i.organization_id=item.organization_id AND i.id=item.instance_id
    JOIN document d ON d.organization_id=i.organization_id AND d.id=i.document_id
    JOIN document_version v ON v.organization_id=i.organization_id AND v.id::text=entry->>'versionId'
    JOIN document_admission a ON a.organization_id=v.organization_id AND a.id=v.admission_id
    WHERE item.organization_id=NEW.organization_id AND item.package_id=package.id AND item.locale=entry->>'locale'
     AND item.instance_id::text=entry->>'instanceId' AND i.document_id::text=entry->>'documentId' AND v.document_id=i.document_id
     AND i.created_by=NEW.created_by AND d.kind='INSTANCE' AND d.source_kind='ONBOARDING' AND d.source_id=package.review_revision_id
     AND d.onboarding_revision_id=package.review_revision_id AND d.locale=item.locale AND d.privacy@>ARRAY['financial','sensitive']::text[]
     AND a.content_type='application/pdf' AND a.file_size::text=entry->>'byteSize' AND a.sha256=entry->>'sha256' AND v.cipher_sha256=entry->>'cipherSha256'
     AND v.created_at<=NEW.created_at AND a.created_at<=NEW.created_at
     AND app_document_version_matches_instance(NEW.organization_id,v.id,i.id)),false)
  THEN RAISE EXCEPTION 'owner delivery requires actual completed original archived PDF versions'; END IF;
 END LOOP;
 FOR entry IN SELECT value FROM jsonb_array_elements(NEW.email_plan) LOOP
  IF NOT coalesce(jsonb_typeof(entry)='object' AND entry-ARRAY['locale','template','fingerprint']='{}'::jsonb
   AND entry->>'locale' IN('en','fr','ar') AND policy.value->'locales' ? (entry->>'locale')
   AND entry->>'template'='onboarding.owner_package' AND entry->>'fingerprint' ~ '^[a-f0-9]{64}$',false)
  THEN RAISE EXCEPTION 'owner delivery requires metadata-only original email identities'; END IF;
 END LOOP;
 RETURN NEW;
END $$;
CREATE TRIGGER owner_delivery_native_guard BEFORE INSERT ON owner_onboarding_delivery FOR EACH ROW EXECUTE FUNCTION app_guard_owner_delivery_native();

CREATE FUNCTION app_guard_owner_delivery_birth() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE package owner_onboarding_package%ROWTYPE;
BEGIN
 SELECT p.* INTO package FROM owner_onboarding_package p WHERE p.organization_id=NEW.organization_id AND p.id=NEW.package_id;
 IF NOT EXISTS(SELECT 1 FROM outbox_event e WHERE e.organization_id=NEW.organization_id AND e.id=NEW.outbox_event_id
  AND e.type='onboarding.owner_package.delivery_requested' AND e.payload=jsonb_build_object('channel','email','ownerDeliveryId',NEW.id::text,'kind','onboarding.owner_package')
  AND e.idempotency_key='owner-package-email:'||NEW.created_by::text||':'||NEW.command_key::text AND e.occurred_at=NEW.created_at
  AND e.status='PENDING' AND e.attempt_count=0 AND e.xmin::text=pg_current_xact_id()::xid::text)
  OR EXISTS(SELECT 1 FROM notification_delivery d WHERE d.organization_id=NEW.organization_id AND d.event_id=NEW.outbox_event_id)
 THEN RAISE EXCEPTION 'owner delivery requires its exact atomic canonical email event without a seeded receipt'; END IF;
 IF NOT EXISTS(SELECT 1 FROM audit_log a WHERE a.organization_id=NEW.organization_id AND a.action='onboarding.owner_delivery_requested'
  AND a.actor_id=NEW.created_by AND a.resource_type='onboarding' AND a.resource_id=package.session_id AND a.property_scope_id=NEW.property_id
  AND a.occurred_at=NEW.created_at AND a.request_id=NEW.request_id AND a.after->>'ownerDeliveryId'=NEW.id::text AND a.after->>'packageId'=NEW.package_id::text
  AND a.after->>'commandHash'=NEW.command_hash AND a.after->>'payloadSha256'=NEW.payload_sha256 AND a.after->>'sourceFingerprint'=NEW.source_fingerprint
  AND a.after->>'outboxEventId'=NEW.outbox_event_id::text AND a.after->>'locale'=NEW.locale::text AND a.xmin::text=pg_current_xact_id()::xid::text)
 THEN RAISE EXCEPTION 'owner delivery requires its exact atomic private audit'; END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER owner_delivery_birth_guard AFTER INSERT ON owner_onboarding_delivery DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app_guard_owner_delivery_birth();

COMMIT;
