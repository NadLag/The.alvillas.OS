BEGIN;
-- Two append-only tenant tables bind all real canonical document admissions atomically.
-- CreateTable
CREATE TABLE "owner_onboarding_package" (
    "id" UUID NOT NULL DEFAULT app_uuid_v7(),
    "organization_id" UUID NOT NULL,
    "session_id" UUID NOT NULL,
    "review_revision_id" UUID NOT NULL,
    "owner_id" UUID NOT NULL,
    "property_id" UUID NOT NULL,
    "command_key" UUID NOT NULL,
    "command_hash" TEXT NOT NULL,
    "review_fingerprint" TEXT NOT NULL,
    "source_fingerprint" TEXT NOT NULL,
    "source_snapshot" JSONB NOT NULL,
    "document_plan" JSONB NOT NULL,
    "encrypted_payload" BYTEA NOT NULL,
    "payload_sha256" TEXT NOT NULL,
    "payload_schema_version" INTEGER NOT NULL DEFAULT 1,
    "policy_id" UUID NOT NULL,
    "policy_version" INTEGER NOT NULL,
    "content_id" UUID NOT NULL,
    "content_version" INTEGER NOT NULL,
    "policy_snapshot" JSONB NOT NULL,
    "authorization_cap" JSONB NOT NULL,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "request_id" TEXT NOT NULL,

    CONSTRAINT "owner_onboarding_package_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "owner_onboarding_package_item" (
    "id" UUID NOT NULL DEFAULT app_uuid_v7(),
    "organization_id" UUID NOT NULL,
    "package_id" UUID NOT NULL,
    "locale" TEXT NOT NULL,
    "instance_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "owner_onboarding_package_item_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "owner_package_session_history_idx" ON "owner_onboarding_package"("organization_id", "session_id", "created_at", "id");

-- CreateIndex
CREATE INDEX "owner_package_property_history_idx" ON "owner_onboarding_package"("organization_id", "property_id", "created_at", "id");

-- CreateIndex
CREATE INDEX "owner_package_creator_history_idx" ON "owner_onboarding_package"("organization_id", "created_by", "created_at", "id");

-- CreateIndex
CREATE UNIQUE INDEX "owner_package_org_id_key" ON "owner_onboarding_package"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "owner_package_org_nonce_key" ON "owner_onboarding_package"("organization_id", "command_key");

-- CreateIndex
CREATE UNIQUE INDEX "owner_package_item_org_id_key" ON "owner_onboarding_package_item"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "owner_package_item_locale_key" ON "owner_onboarding_package_item"("organization_id", "package_id", "locale");

-- CreateIndex
CREATE UNIQUE INDEX "owner_package_item_instance_key" ON "owner_onboarding_package_item"("organization_id", "instance_id");

-- AddForeignKey
ALTER TABLE "owner_onboarding_package" ADD CONSTRAINT "owner_package_org_fk" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "owner_onboarding_package" ADD CONSTRAINT "owner_package_session_fk" FOREIGN KEY ("organization_id", "session_id") REFERENCES "property_onboarding_session"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "owner_onboarding_package" ADD CONSTRAINT "owner_package_review_fk" FOREIGN KEY ("organization_id", "session_id", "review_revision_id") REFERENCES "property_onboarding_revision"("organization_id", "session_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "owner_onboarding_package" ADD CONSTRAINT "owner_package_owner_fk" FOREIGN KEY ("organization_id", "owner_id") REFERENCES "owner"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "owner_onboarding_package" ADD CONSTRAINT "owner_package_property_fk" FOREIGN KEY ("organization_id", "property_id") REFERENCES "property"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "owner_onboarding_package" ADD CONSTRAINT "owner_package_creator_fk" FOREIGN KEY ("organization_id", "created_by") REFERENCES "user_account"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "owner_onboarding_package" ADD CONSTRAINT "owner_package_policy_fk" FOREIGN KEY ("organization_id", "policy_id") REFERENCES "config_rule"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "owner_onboarding_package" ADD CONSTRAINT "owner_package_content_fk" FOREIGN KEY ("organization_id", "content_id") REFERENCES "config_rule"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "owner_onboarding_package_item" ADD CONSTRAINT "owner_package_item_org_fk" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "owner_onboarding_package_item" ADD CONSTRAINT "owner_package_item_package_fk" FOREIGN KEY ("organization_id", "package_id") REFERENCES "owner_onboarding_package"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "owner_onboarding_package_item" ADD CONSTRAINT "owner_package_item_instance_fk" FOREIGN KEY ("organization_id", "instance_id") REFERENCES "document_instance"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;


ALTER TABLE owner_onboarding_package ENABLE ROW LEVEL SECURITY;
ALTER TABLE owner_onboarding_package FORCE ROW LEVEL SECURITY;
CREATE POLICY owner_onboarding_package_tenant_isolation ON owner_onboarding_package
 USING(organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid)
 WITH CHECK(organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid);
ALTER TABLE owner_onboarding_package_item ENABLE ROW LEVEL SECURITY;
ALTER TABLE owner_onboarding_package_item FORCE ROW LEVEL SECURITY;
CREATE POLICY owner_onboarding_package_item_tenant_isolation ON owner_onboarding_package_item
 USING(organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid)
 WITH CHECK(organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid);
CREATE TRIGGER owner_package_immutable BEFORE UPDATE OR DELETE ON owner_onboarding_package FOR EACH ROW EXECUTE FUNCTION app_onboarding_append_only();
CREATE TRIGGER owner_package_item_immutable BEFORE UPDATE OR DELETE ON owner_onboarding_package_item FOR EACH ROW EXECUTE FUNCTION app_onboarding_append_only();

-- Canonical JSON fingerprints and private payload purposes are authenticated by the existing application helper.
-- SQL binds actual immutable native IDs/versions, scopes and exact atomic document/audit lineage.
ALTER TABLE owner_onboarding_package ADD CONSTRAINT owner_package_shape CHECK(coalesce(
 isfinite(created_at) AND payload_schema_version=1 AND policy_version>0 AND content_version>0
 AND length(request_id) BETWEEN 1 AND 200 AND octet_length(encrypted_payload) BETWEEN 64 AND 1048576
 AND payload_sha256=encode(sha256(encrypted_payload),'hex') AND command_hash ~ '^[a-f0-9]{64}$'
 AND review_fingerprint ~ '^[a-f0-9]{64}$' AND source_fingerprint ~ '^[a-f0-9]{64}$'
 AND jsonb_typeof(source_snapshot)='object' AND source_snapshot->>'source'='NATIVE_ONBOARDING_OWNER_PACKAGE_V1'
 AND source_snapshot->>'organizationId'=organization_id::text AND source_snapshot->>'sessionId'=session_id::text
 AND source_snapshot->>'reviewRevisionId'=review_revision_id::text AND source_snapshot->>'ownerId'=owner_id::text
 AND source_snapshot->>'propertyId'=property_id::text AND source_snapshot->>'contentId'=content_id::text
 AND source_snapshot->>'contentVersion'=content_version::text AND source_snapshot->>'reviewSourceFingerprint' ~ '^[a-f0-9]{64}$'
 AND source_snapshot->>'nativePackageFingerprint' ~ '^[a-f0-9]{64}$'
 AND jsonb_typeof(document_plan)='array' AND jsonb_array_length(document_plan) BETWEEN 2 AND 3 AND octet_length(document_plan::text)<=65536
 AND jsonb_typeof(policy_snapshot)='object' AND policy_snapshot->>'id'=policy_id::text AND policy_snapshot->>'version'=policy_version::text
 AND jsonb_typeof(authorization_cap)='object' AND authorization_cap->>'schemaVersion'='1'
 AND authorization_cap->>'organizationId'=organization_id::text AND authorization_cap->>'userAccountId'=created_by::text
 AND jsonb_typeof(authorization_cap->'permissions')='array' AND jsonb_typeof(authorization_cap->'scopes')='array',false));
ALTER TABLE owner_onboarding_package_item ADD CONSTRAINT owner_package_item_shape CHECK(isfinite(created_at) AND locale IN('en','fr','ar'));

CREATE FUNCTION app_guard_owner_package_native() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE reviewed property_onboarding_revision%ROWTYPE;head_id uuid;target property%ROWTYPE;policy config_rule%ROWTYPE;content config_rule%ROWTYPE;
 selected config_rule%ROWTYPE;pinned jsonb;target_xmin text;target_tuple text;owner_xmin text;owner_tuple text;entry jsonb;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended(NEW.organization_id::text||':onboarding:session:'||NEW.session_id::text,0));
 SELECT id INTO head_id FROM property_onboarding_revision WHERE organization_id=NEW.organization_id AND session_id=NEW.session_id ORDER BY number DESC LIMIT 1;
 SELECT * INTO reviewed FROM property_onboarding_revision WHERE organization_id=NEW.organization_id AND id=NEW.review_revision_id;
 SELECT * INTO target FROM property WHERE organization_id=NEW.organization_id AND id=NEW.property_id FOR UPDATE;
 SELECT xmin::text,ctid::text INTO target_xmin,target_tuple FROM property WHERE organization_id=NEW.organization_id AND id=NEW.property_id;
 SELECT xmin::text,ctid::text INTO owner_xmin,owner_tuple FROM owner WHERE organization_id=NEW.organization_id AND id=NEW.owner_id AND archived_at IS NULL;
 IF NOT coalesce(reviewed.id=head_id AND reviewed.step='REVIEW' AND reviewed.mode='VALIDATE' AND reviewed.session_id=NEW.session_id
  AND reviewed.owner_id=NEW.owner_id AND reviewed.property_id=NEW.property_id AND NEW.created_at>=reviewed.created_at
  AND target.id IS NOT NULL AND target.archived_at IS NULL AND target.status IN('DRAFT','ONBOARDING') AND owner_xmin IS NOT NULL
  AND reviewed.source_snapshot#>>'{parent,property,xmin}'=target_xmin AND reviewed.source_snapshot#>>'{parent,property,tuple}'=target_tuple
  AND reviewed.source_snapshot#>>'{parent,owner,ownerXmin}'=owner_xmin AND reviewed.source_snapshot#>>'{parent,owner,ownerTuple}'=owner_tuple
  AND NEW.source_snapshot->>'reviewSourceFingerprint'=reviewed.source_fingerprint
  AND NEW.source_snapshot->>'agreementId'=reviewed.source_snapshot#>>'{agreement,id}'
  AND EXISTS(SELECT 1 FROM property_owner WHERE organization_id=NEW.organization_id AND property_id=NEW.property_id AND owner_id=NEW.owner_id AND archived_at IS NULL),false)
 THEN RAISE EXCEPTION 'owner package requires its actual current native Review and original property'; END IF;
 IF EXISTS(SELECT 1 FROM property_onboarding_revision WHERE organization_id=NEW.organization_id AND command_key=NEW.command_key)
  OR EXISTS(SELECT 1 FROM property_onboarding_activation_request WHERE organization_id=NEW.organization_id AND command_key=NEW.command_key)
 THEN RAISE EXCEPTION 'owner package requires its original independent command nonce'; END IF;
 SELECT * INTO policy FROM config_rule WHERE organization_id=NEW.organization_id AND id=NEW.policy_id;
 SELECT * INTO content FROM config_rule WHERE organization_id=NEW.organization_id AND id=NEW.content_id;
 IF NOT coalesce(policy.key='onboarding.owner_package' AND policy.version=NEW.policy_version AND content.key='finance.onboarding_package_content'
  AND content.version=NEW.content_version AND NEW.policy_snapshot=jsonb_build_object('id',policy.id,'version',policy.version,'value',policy.value)
  AND policy.value->>'source'='NATIVE_VALIDATED_ONBOARDING_REVIEW' AND policy.value->>'content_key'='finance.onboarding_package_content'
  AND content.value->>'agreement_id'=NEW.source_snapshot->>'agreementId'
  AND jsonb_typeof(policy.value->'templates')='object' AND (SELECT count(*) FROM jsonb_object_keys(policy.value->'templates')) BETWEEN 2 AND 3
  AND policy.value->'templates' ? 'en' AND policy.value->'templates' ? 'fr'
  AND jsonb_typeof(content.value->'agreement_rules')='array' AND jsonb_array_length(content.value->'agreement_rules')=7
  AND jsonb_array_length(reviewed.source_snapshot->'agreementRules')=7,false)
 THEN RAISE EXCEPTION 'owner package requires its actual approved policy and pinned agreement wording'; END IF;
 FOR selected IN SELECT * FROM config_rule WHERE organization_id=NEW.organization_id AND id IN(NEW.policy_id,NEW.content_id) LOOP
  IF NOT coalesce(selected.created_by IS NOT NULL AND selected.archived_at IS NULL AND selected.lifecycle='ACTIVE'
   AND selected.effective_from<=NEW.created_at AND (selected.effective_to IS NULL OR selected.effective_to>NEW.created_at)
   AND CASE selected.scope_type WHEN 'organization' THEN selected.scope_id IS NULL WHEN 'property' THEN selected.scope_id=NEW.property_id
    WHEN 'owner' THEN selected.scope_id=NEW.owner_id WHEN 'city' THEN selected.scope_id=target.city_id
    WHEN 'agreement' THEN selected.scope_id::text=NEW.source_snapshot->>'agreementId' ELSE false END,false)
  THEN RAISE EXCEPTION 'owner package policy and content require their actual tenant source scope'; END IF;
 END LOOP;
 FOR pinned IN SELECT value FROM jsonb_array_elements(content.value->'agreement_rules') LOOP
  IF NOT EXISTS(SELECT 1 FROM config_rule r JOIN jsonb_array_elements(reviewed.source_snapshot->'agreementRules') original ON original->>'id'=r.id::text
   WHERE r.organization_id=NEW.organization_id AND r.id::text=pinned->>'id' AND r.key=pinned->>'key' AND r.version::text=pinned->>'version'
    AND original->>'key'=r.key AND original->>'version'=r.version::text AND r.scope_type='agreement'
    AND r.scope_id::text=NEW.source_snapshot->>'agreementId' AND pinned->>'value_fingerprint' ~ '^[a-f0-9]{64}$')
  THEN RAISE EXCEPTION 'owner package wording requires every actual original agreement rule'; END IF;
 END LOOP;
 IF (SELECT count(DISTINCT value->>'key') FROM jsonb_array_elements(content.value->'agreement_rules'))<>7
  OR (SELECT count(DISTINCT value->>'id') FROM jsonb_array_elements(content.value->'agreement_rules'))<>7
  OR jsonb_array_length(NEW.document_plan)<>(SELECT count(*) FROM jsonb_object_keys(policy.value->'templates'))
  OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(NEW.document_plan) item WHERE item->>'locale'='en')
  OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(NEW.document_plan) item WHERE item->>'locale'='fr')
  OR (SELECT count(DISTINCT value->>'locale') FROM jsonb_array_elements(NEW.document_plan))<>jsonb_array_length(NEW.document_plan)
  OR (SELECT count(DISTINCT value->>'instanceId') FROM jsonb_array_elements(NEW.document_plan))<>jsonb_array_length(NEW.document_plan)
  OR (SELECT count(DISTINCT value->>'documentId') FROM jsonb_array_elements(NEW.document_plan))<>jsonb_array_length(NEW.document_plan)
  OR (SELECT count(DISTINCT value->>'templateVersionId') FROM jsonb_array_elements(NEW.document_plan))<>jsonb_array_length(NEW.document_plan)
  OR (SELECT count(DISTINCT value->>'commandKeyFingerprint') FROM jsonb_array_elements(NEW.document_plan))<>jsonb_array_length(NEW.document_plan)
 THEN RAISE EXCEPTION 'owner package requires every distinct configured language original'; END IF;
 FOR entry IN SELECT value FROM jsonb_array_elements(NEW.document_plan) LOOP
  IF NOT coalesce(entry->>'locale' IN('en','fr','ar') AND policy.value->'templates'->>(entry->>'locale')=entry->>'templateVersionId'
   AND entry->>'templateSha256' ~ '^[a-f0-9]{64}$' AND entry->>'commandKeyFingerprint' ~ '^[a-f0-9]{64}$'
   AND entry->>'sourceFingerprint' ~ '^[a-f0-9]{64}$' AND entry->>'reviewFingerprint' ~ '^[a-f0-9]{64}$',false)
  THEN RAISE EXCEPTION 'owner package language plan requires its exact native identities'; END IF;
 END LOOP;
 RETURN NEW;
END $$;
CREATE TRIGGER owner_package_native_guard BEFORE INSERT ON owner_onboarding_package FOR EACH ROW EXECUTE FUNCTION app_guard_owner_package_native();

CREATE FUNCTION app_guard_owner_package_item() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE package owner_onboarding_package%ROWTYPE;instance document_instance%ROWTYPE;root document%ROWTYPE;entry jsonb;
BEGIN
 SELECT * INTO package FROM owner_onboarding_package WHERE organization_id=NEW.organization_id AND id=NEW.package_id;
 SELECT value INTO entry FROM jsonb_array_elements(package.document_plan) WHERE value->>'locale'=NEW.locale;
 SELECT * INTO instance FROM document_instance WHERE organization_id=NEW.organization_id AND id=NEW.instance_id;
 SELECT * INTO root FROM document WHERE organization_id=NEW.organization_id AND id=instance.document_id;
 IF NOT coalesce(package.id IS NOT NULL AND NEW.created_at=package.created_at AND instance.id::text=entry->>'instanceId'
  AND instance.document_id::text=entry->>'documentId' AND instance.template_version_id::text=entry->>'templateVersionId'
  AND instance.source_fingerprint=entry->>'sourceFingerprint' AND instance.created_by=package.created_by AND instance.created_at<=package.created_at
  AND instance.source_snapshot->>'protocol'='ALVILLAS_GENERATED_DOCUMENT_V1'
  AND instance.source_snapshot#>>'{identity,templateSha256}'=entry->>'templateSha256'
  AND instance.source_snapshot#>>'{command,reviewFingerprint}'=entry->>'reviewFingerprint'
  AND instance.source_snapshot->'authorizationCap'=package.authorization_cap
  AND encode(sha256(convert_to(instance.command_key::text,'UTF8')),'hex')=entry->>'commandKeyFingerprint'
  AND root.kind='INSTANCE' AND root.source_kind='ONBOARDING' AND root.source_id=package.review_revision_id
  AND root.onboarding_revision_id=package.review_revision_id AND root.locale=NEW.locale
  AND root.type_key=package.policy_snapshot#>>'{value,document_type}' AND root.privacy@>ARRAY['financial','sensitive']::text[],false)
 THEN RAISE EXCEPTION 'owner package item requires its actual canonical original document admission'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER owner_package_item_native_guard BEFORE INSERT ON owner_onboarding_package_item FOR EACH ROW EXECUTE FUNCTION app_guard_owner_package_item();

CREATE FUNCTION app_guard_owner_package_birth() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE package owner_onboarding_package%ROWTYPE;package_id uuid;item_count integer;
BEGIN
 IF TG_TABLE_NAME='owner_onboarding_package' THEN package_id=NEW.id; ELSE package_id=NEW.package_id; END IF;
 SELECT p.* INTO package FROM owner_onboarding_package p WHERE p.organization_id=NEW.organization_id AND p.id=package_id;
 SELECT count(*) INTO item_count FROM owner_onboarding_package_item WHERE organization_id=package.organization_id AND owner_onboarding_package_item.package_id=package.id;
 IF package.id IS NULL OR item_count<>jsonb_array_length(package.document_plan)
  OR NOT EXISTS(SELECT 1 FROM owner_onboarding_package p WHERE p.organization_id=package.organization_id AND p.id=package.id AND p.xmin::text=pg_current_xact_id()::xid::text)
  OR EXISTS(SELECT 1 FROM owner_onboarding_package_item item JOIN document_instance i ON i.organization_id=item.organization_id AND i.id=item.instance_id
   WHERE item.organization_id=package.organization_id AND item.package_id=package.id AND (item.xmin::text<>pg_current_xact_id()::xid::text OR i.xmin::text<>pg_current_xact_id()::xid::text))
  OR (SELECT count(DISTINCT i.source_snapshot->'policySnapshot') FROM owner_onboarding_package_item item JOIN document_instance i ON i.organization_id=item.organization_id AND i.id=item.instance_id WHERE item.organization_id=package.organization_id AND item.package_id=package.id)<>1
  OR (SELECT count(DISTINCT i.source_snapshot->'variants') FROM owner_onboarding_package_item item JOIN document_instance i ON i.organization_id=item.organization_id AND i.id=item.instance_id WHERE item.organization_id=package.organization_id AND item.package_id=package.id)<>1
  OR (SELECT count(DISTINCT i.source_snapshot->>'contractFingerprint') FROM owner_onboarding_package_item item JOIN document_instance i ON i.organization_id=item.organization_id AND i.id=item.instance_id WHERE item.organization_id=package.organization_id AND item.package_id=package.id)<>1
 THEN RAISE EXCEPTION 'owner package requires all actual language admissions in the same transaction'; END IF;
 IF EXISTS(SELECT 1 FROM owner_onboarding_package_item item JOIN document_instance i ON i.organization_id=item.organization_id AND i.id=item.instance_id
  WHERE item.organization_id=package.organization_id AND item.package_id=package.id AND NOT EXISTS(SELECT 1 FROM outbox_event e WHERE e.organization_id=i.organization_id
   AND e.type='documents.instance.requested' AND e.payload=jsonb_build_object('instanceId',i.id::text)
   AND e.idempotency_key='document-generation:'||i.created_by::text||':'||i.command_key::text AND e.occurred_at=i.created_at AND e.xmin::text=pg_current_xact_id()::xid::text))
 THEN RAISE EXCEPTION 'owner package requires both canonical document worker outboxes'; END IF;
 IF NOT EXISTS(SELECT 1 FROM audit_log a WHERE a.organization_id=package.organization_id AND a.action='onboarding.owner_package_requested'
  AND a.actor_id=package.created_by AND a.resource_type='onboarding' AND a.resource_id=package.session_id
  AND a.property_scope_id=package.property_id AND a.occurred_at=package.created_at AND a.request_id=package.request_id
  AND a.after->>'packageId'=package.id::text AND a.after->>'reviewRevisionId'=package.review_revision_id::text
  AND a.after->>'commandHash'=package.command_hash AND a.after->>'payloadSha256'=package.payload_sha256
  AND a.after->>'sourceFingerprint'=package.source_fingerprint AND a.xmin::text=pg_current_xact_id()::xid::text)
 THEN RAISE EXCEPTION 'owner package requires its exact atomic private audit'; END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER owner_package_birth_guard AFTER INSERT ON owner_onboarding_package DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app_guard_owner_package_birth();
CREATE CONSTRAINT TRIGGER owner_package_item_birth_guard AFTER INSERT ON owner_onboarding_package_item DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app_guard_owner_package_birth();

COMMIT;
