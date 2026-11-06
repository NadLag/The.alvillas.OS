BEGIN;

-- CreateTable
CREATE TABLE "document" (
    "id" UUID NOT NULL DEFAULT app_uuid_v7(),
    "organization_id" UUID NOT NULL,
    "source_kind" TEXT NOT NULL,
    "source_id" UUID NOT NULL,
    "property_id" UUID,
    "owner_id" UUID,
    "reservation_id" UUID,
    "person_id" UUID,
    "transaction_id" UUID,
    "type_key" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "locale" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "privacy" TEXT[],
    "source_snapshot" JSONB NOT NULL,
    "policy_snapshot" JSONB NOT NULL,
    "revision" BIGINT NOT NULL DEFAULT 1,
    "command_key" UUID NOT NULL,
    "command_hash" CHAR(64) NOT NULL,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "archived_at" TIMESTAMPTZ(6),

    CONSTRAINT "document_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "document_admission" (
    "id" UUID NOT NULL DEFAULT app_uuid_v7(),
    "organization_id" UUID NOT NULL,
    "document_id" UUID NOT NULL,
    "supersedes_id" UUID,
    "expected_revision" BIGINT NOT NULL,
    "authorization_cap" JSONB NOT NULL,
    "policy_snapshot" JSONB NOT NULL,
    "source_fingerprint" CHAR(64) NOT NULL,
    "input" JSONB NOT NULL,
    "command_key" UUID NOT NULL,
    "command_hash" CHAR(64) NOT NULL,
    "file_name" TEXT NOT NULL,
    "content_type" TEXT NOT NULL,
    "file_size" INTEGER NOT NULL,
    "sha256" CHAR(64) NOT NULL,
    "storage_key" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "document_admission_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "document_version" (
    "id" UUID NOT NULL DEFAULT app_uuid_v7(),
    "organization_id" UUID NOT NULL,
    "document_id" UUID NOT NULL,
    "admission_id" UUID NOT NULL,
    "number" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "supersedes_id" UUID,
    "effective_from" TIMESTAMPTZ(6),
    "cipher_size" INTEGER NOT NULL,
    "cipher_sha256" CHAR(64) NOT NULL,
    "key_version" TEXT NOT NULL,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "document_version_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "document_template" (
    "id" UUID NOT NULL DEFAULT app_uuid_v7(),
    "organization_id" UUID NOT NULL,
    "document_id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "locale" TEXT NOT NULL,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "document_template_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "document_instance" (
    "id" UUID NOT NULL DEFAULT app_uuid_v7(),
    "organization_id" UUID NOT NULL,
    "document_id" UUID NOT NULL,
    "template_version_id" UUID NOT NULL,
    "source_snapshot" JSONB NOT NULL,
    "source_fingerprint" CHAR(64) NOT NULL,
    "command_key" UUID NOT NULL,
    "command_hash" CHAR(64) NOT NULL,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "document_instance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "signature" (
    "id" UUID NOT NULL DEFAULT app_uuid_v7(),
    "organization_id" UUID NOT NULL,
    "instance_id" UUID NOT NULL,
    "document_version_id" UUID NOT NULL,
    "policy_snapshot" JSONB NOT NULL,
    "authorization_cap" JSONB NOT NULL,
    "source_fingerprint" CHAR(64) NOT NULL,
    "command_key" UUID NOT NULL,
    "command_hash" CHAR(64) NOT NULL,
    "reason" TEXT NOT NULL,
    "requested_by" UUID NOT NULL,
    "requested_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "signature_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "signature_recipient" (
    "id" UUID NOT NULL DEFAULT app_uuid_v7(),
    "organization_id" UUID NOT NULL,
    "signature_id" UUID NOT NULL,
    "person_id" UUID,
    "owner_id" UUID,
    "guest_id" UUID,
    "supplier_id" UUID,
    "identity_hash" CHAR(64) NOT NULL,
    "email_cipher" BYTEA NOT NULL,
    "source_snapshot" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "signature_recipient_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "signature_event" (
    "id" UUID NOT NULL DEFAULT app_uuid_v7(),
    "organization_id" UUID NOT NULL,
    "signature_id" UUID NOT NULL,
    "state" TEXT NOT NULL,
    "provider_identity_hash" CHAR(64),
    "provider_request_id" TEXT,
    "provider_event_id" TEXT,
    "evidence_hash" CHAR(64) NOT NULL,
    "evidence_cipher" BYTEA,
    "signed_version_id" UUID,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL,
    "observed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "signature_event_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "document_action" (
    "id" UUID NOT NULL DEFAULT app_uuid_v7(),
    "organization_id" UUID NOT NULL,
    "document_id" UUID NOT NULL,
    "action" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "before" JSONB NOT NULL,
    "after" JSONB NOT NULL,
    "source_fingerprint" CHAR(64) NOT NULL,
    "command_key" UUID NOT NULL,
    "command_hash" CHAR(64) NOT NULL,
    "actor_id" UUID NOT NULL,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "document_action_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "document_source_page_idx" ON "document"("organization_id", "source_kind", "source_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "document_org_id_unique" ON "document"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "document_command_unique" ON "document"("organization_id", "created_by", "command_key");

-- CreateIndex
CREATE UNIQUE INDEX "document_admission_org_id_unique" ON "document_admission"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "document_admission_command_unique" ON "document_admission"("organization_id", "created_by", "command_key");

-- CreateIndex
CREATE UNIQUE INDEX "document_admission_storage_unique" ON "document_admission"("organization_id", "storage_key");

-- CreateIndex
CREATE UNIQUE INDEX "document_version_org_id_unique" ON "document_version"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "document_version_number_unique" ON "document_version"("organization_id", "document_id", "number");

-- CreateIndex
CREATE UNIQUE INDEX "document_version_admission_unique" ON "document_version"("organization_id", "admission_id");

-- CreateIndex
CREATE UNIQUE INDEX "document_version_successor_unique" ON "document_version"("organization_id", "supersedes_id");

-- CreateIndex
CREATE UNIQUE INDEX "document_template_org_id_unique" ON "document_template"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "document_template_document_unique" ON "document_template"("organization_id", "document_id");

-- CreateIndex
CREATE UNIQUE INDEX "document_template_locale_unique" ON "document_template"("organization_id", "key", "locale");

-- CreateIndex
CREATE UNIQUE INDEX "document_instance_org_id_unique" ON "document_instance"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "document_instance_document_unique" ON "document_instance"("organization_id", "document_id");

-- CreateIndex
CREATE UNIQUE INDEX "document_instance_command_unique" ON "document_instance"("organization_id", "created_by", "command_key");

-- CreateIndex
CREATE INDEX "signature_document_version_idx" ON "signature"("organization_id", "document_version_id");

-- CreateIndex
CREATE UNIQUE INDEX "signature_org_id_unique" ON "signature"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "signature_command_unique" ON "signature"("organization_id", "requested_by", "command_key");

-- CreateIndex
CREATE UNIQUE INDEX "signature_recipient_org_id_unique" ON "signature_recipient"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "signature_recipient_identity_unique" ON "signature_recipient"("organization_id", "signature_id", "identity_hash");

-- CreateIndex
CREATE INDEX "signature_event_history_idx" ON "signature_event"("organization_id", "signature_id", "occurred_at", "id");

-- CreateIndex
CREATE UNIQUE INDEX "signature_event_org_id_unique" ON "signature_event"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "signature_event_provider_identity_unique" ON "signature_event"("provider_identity_hash", "provider_event_id");

-- CreateIndex
CREATE UNIQUE INDEX "signature_event_evidence_unique" ON "signature_event"("organization_id", "signature_id", "evidence_hash");

-- CreateIndex
CREATE INDEX "document_action_history_idx" ON "document_action"("organization_id", "document_id", "occurred_at", "id");

-- CreateIndex
CREATE UNIQUE INDEX "document_action_org_id_unique" ON "document_action"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "document_action_command_unique" ON "document_action"("organization_id", "actor_id", "command_key", "action");

-- AddForeignKey
ALTER TABLE "document" ADD CONSTRAINT "document_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "document" ADD CONSTRAINT "document_organization_id_created_by_fkey" FOREIGN KEY ("organization_id", "created_by") REFERENCES "user_account"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "document" ADD CONSTRAINT "document_organization_id_property_id_fkey" FOREIGN KEY ("organization_id", "property_id") REFERENCES "property"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "document" ADD CONSTRAINT "document_organization_id_owner_id_fkey" FOREIGN KEY ("organization_id", "owner_id") REFERENCES "owner"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "document" ADD CONSTRAINT "document_organization_id_reservation_id_fkey" FOREIGN KEY ("organization_id", "reservation_id") REFERENCES "reservation"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "document" ADD CONSTRAINT "document_organization_id_person_id_fkey" FOREIGN KEY ("organization_id", "person_id") REFERENCES "person"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "document" ADD CONSTRAINT "document_organization_id_transaction_id_fkey" FOREIGN KEY ("organization_id", "transaction_id") REFERENCES "financial_transaction"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "document_admission" ADD CONSTRAINT "document_admission_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "document_admission" ADD CONSTRAINT "document_admission_organization_id_document_id_fkey" FOREIGN KEY ("organization_id", "document_id") REFERENCES "document"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "document_admission" ADD CONSTRAINT "document_admission_organization_id_created_by_fkey" FOREIGN KEY ("organization_id", "created_by") REFERENCES "user_account"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "document_admission" ADD CONSTRAINT "document_admission_organization_id_supersedes_id_fkey" FOREIGN KEY ("organization_id", "supersedes_id") REFERENCES "document_version"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "document_version" ADD CONSTRAINT "document_version_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "document_version" ADD CONSTRAINT "document_version_organization_id_document_id_fkey" FOREIGN KEY ("organization_id", "document_id") REFERENCES "document"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "document_version" ADD CONSTRAINT "document_version_organization_id_admission_id_fkey" FOREIGN KEY ("organization_id", "admission_id") REFERENCES "document_admission"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "document_version" ADD CONSTRAINT "document_version_organization_id_created_by_fkey" FOREIGN KEY ("organization_id", "created_by") REFERENCES "user_account"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "document_version" ADD CONSTRAINT "document_version_organization_id_supersedes_id_fkey" FOREIGN KEY ("organization_id", "supersedes_id") REFERENCES "document_version"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "document_template" ADD CONSTRAINT "document_template_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "document_template" ADD CONSTRAINT "document_template_organization_id_document_id_fkey" FOREIGN KEY ("organization_id", "document_id") REFERENCES "document"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "document_template" ADD CONSTRAINT "document_template_organization_id_created_by_fkey" FOREIGN KEY ("organization_id", "created_by") REFERENCES "user_account"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "document_instance" ADD CONSTRAINT "document_instance_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "document_instance" ADD CONSTRAINT "document_instance_organization_id_document_id_fkey" FOREIGN KEY ("organization_id", "document_id") REFERENCES "document"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "document_instance" ADD CONSTRAINT "document_instance_organization_id_template_version_id_fkey" FOREIGN KEY ("organization_id", "template_version_id") REFERENCES "document_version"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "document_instance" ADD CONSTRAINT "document_instance_organization_id_created_by_fkey" FOREIGN KEY ("organization_id", "created_by") REFERENCES "user_account"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "signature" ADD CONSTRAINT "signature_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "signature" ADD CONSTRAINT "signature_organization_id_instance_id_fkey" FOREIGN KEY ("organization_id", "instance_id") REFERENCES "document_instance"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "signature" ADD CONSTRAINT "signature_organization_id_document_version_id_fkey" FOREIGN KEY ("organization_id", "document_version_id") REFERENCES "document_version"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "signature" ADD CONSTRAINT "signature_organization_id_requested_by_fkey" FOREIGN KEY ("organization_id", "requested_by") REFERENCES "user_account"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "signature_recipient" ADD CONSTRAINT "signature_recipient_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "signature_recipient" ADD CONSTRAINT "signature_recipient_organization_id_signature_id_fkey" FOREIGN KEY ("organization_id", "signature_id") REFERENCES "signature"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "signature_recipient" ADD CONSTRAINT "signature_recipient_organization_id_person_id_fkey" FOREIGN KEY ("organization_id", "person_id") REFERENCES "person"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "signature_recipient" ADD CONSTRAINT "signature_recipient_organization_id_owner_id_fkey" FOREIGN KEY ("organization_id", "owner_id") REFERENCES "owner"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "signature_recipient" ADD CONSTRAINT "signature_recipient_organization_id_guest_id_fkey" FOREIGN KEY ("organization_id", "guest_id") REFERENCES "guest"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "signature_recipient" ADD CONSTRAINT "signature_recipient_organization_id_supplier_id_fkey" FOREIGN KEY ("organization_id", "supplier_id") REFERENCES "supplier"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "signature_event" ADD CONSTRAINT "signature_event_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "signature_event" ADD CONSTRAINT "signature_event_organization_id_signature_id_fkey" FOREIGN KEY ("organization_id", "signature_id") REFERENCES "signature"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "signature_event" ADD CONSTRAINT "signature_event_organization_id_signed_version_id_fkey" FOREIGN KEY ("organization_id", "signed_version_id") REFERENCES "document_version"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "document_action" ADD CONSTRAINT "document_action_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "document_action" ADD CONSTRAINT "document_action_organization_id_document_id_fkey" FOREIGN KEY ("organization_id", "document_id") REFERENCES "document"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "document_action" ADD CONSTRAINT "document_action_organization_id_actor_id_fkey" FOREIGN KEY ("organization_id", "actor_id") REFERENCES "user_account"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;


ALTER TABLE document ALTER COLUMN privacy SET NOT NULL;
ALTER TABLE document ADD CONSTRAINT document_source_shape CHECK (coalesce((
  (source_kind='ORGANIZATION' AND source_id=organization_id AND num_nonnulls(property_id,owner_id,reservation_id,person_id,transaction_id)=0)
  OR (num_nonnulls(property_id,owner_id,reservation_id,person_id,transaction_id)=1 AND
    ((source_kind='PROPERTY' AND property_id=source_id) OR (source_kind='OWNER' AND owner_id=source_id)
     OR (source_kind='RESERVATION' AND reservation_id=source_id) OR (source_kind='PERSON' AND person_id=source_id)
     OR (source_kind='FINANCIAL_TRANSACTION' AND transaction_id=source_id)))),false));
ALTER TABLE document ADD CONSTRAINT document_archive_shape CHECK (
  kind IN ('FILE','TEMPLATE','INSTANCE') AND locale IN ('en','fr','ar') AND type_key ~ '^[a-z][a-z0-9_]{0,119}$'
  AND length(title) BETWEEN 1 AND 500 AND revision>0 AND command_hash ~ '^[a-f0-9]{64}$'
  AND cardinality(privacy) BETWEEN 1 AND 3 AND privacy<@ARRAY['operational','financial','sensitive']::text[] AND array_position(privacy,NULL) IS NULL
  AND (source_kind<>'FINANCIAL_TRANSACTION' OR privacy@>ARRAY['financial']) AND (source_kind<>'PERSON' OR privacy@>ARRAY['sensitive'])
  AND jsonb_typeof(source_snapshot)='object' AND jsonb_typeof(policy_snapshot)='object');
ALTER TABLE document_admission ADD CONSTRAINT document_admission_shape CHECK (
  file_size BETWEEN 1 AND 10485760 AND length(file_name) BETWEEN 1 AND 240 AND file_name !~ '[[:cntrl:]/\\]'
  AND content_type IN ('application/pdf','image/png','image/jpeg','application/vnd.openxmlformats-officedocument.wordprocessingml.document','application/json','text/plain')
  AND sha256 ~ '^[a-f0-9]{64}$' AND command_hash ~ '^[a-f0-9]{64}$' AND source_fingerprint ~ '^[a-f0-9]{64}$'
  AND expected_revision>0 AND length(reason) BETWEEN 8 AND 1000 AND jsonb_typeof(authorization_cap)='object' AND jsonb_typeof(input)='object'
  AND storage_key='organizations/'||organization_id::text||'/documents/'||document_id::text||'/admissions/'||id::text||'.encrypted');
ALTER TABLE document_version ADD CONSTRAINT document_version_shape CHECK (
  number>0 AND cipher_size>0 AND cipher_sha256 ~ '^[a-f0-9]{64}$' AND length(key_version) BETWEEN 1 AND 180
  AND length(title) BETWEEN 1 AND 500 AND ((number=1 AND supersedes_id IS NULL) OR (number>1 AND supersedes_id IS NOT NULL)));
ALTER TABLE document_template ADD CONSTRAINT document_template_shape CHECK (key ~ '^[a-z][a-z0-9_]{0,119}$' AND locale IN ('en','fr','ar'));
ALTER TABLE document_instance ADD CONSTRAINT document_instance_shape CHECK (
  command_hash ~ '^[a-f0-9]{64}$' AND source_fingerprint ~ '^[a-f0-9]{64}$' AND jsonb_typeof(source_snapshot)='object');
ALTER TABLE signature ADD CONSTRAINT signature_shape CHECK (
  command_hash ~ '^[a-f0-9]{64}$' AND source_fingerprint ~ '^[a-f0-9]{64}$' AND length(reason) BETWEEN 8 AND 1000
  AND jsonb_typeof(policy_snapshot)='object' AND jsonb_typeof(authorization_cap)='object');
ALTER TABLE signature_recipient ADD CONSTRAINT signature_recipient_shape CHECK (
  num_nonnulls(person_id,owner_id,guest_id,supplier_id)=1 AND identity_hash ~ '^[a-f0-9]{64}$' AND octet_length(email_cipher)>0 AND jsonb_typeof(source_snapshot)='object');
ALTER TABLE signature_event ADD CONSTRAINT signature_event_shape CHECK (coalesce((
  state IN ('DRAFT','SENT','VIEWED','SIGNED','DECLINED','EXPIRED','FAILED') AND evidence_hash ~ '^[a-f0-9]{64}$'
  AND ((state='DRAFT' AND num_nonnulls(provider_identity_hash,provider_request_id,provider_event_id,evidence_cipher,signed_version_id)=0)
    OR (state<>'DRAFT' AND provider_identity_hash ~ '^[a-f0-9]{64}$' AND length(provider_request_id)>0 AND length(provider_event_id)>0 AND octet_length(evidence_cipher)>0))
  AND ((state='SIGNED')=(signed_version_id IS NOT NULL)) AND occurred_at<=observed_at),false));
ALTER TABLE document_action ADD CONSTRAINT document_action_shape CHECK (
  action IN ('CREATED','ADMITTED','VERSION_ADDED','ARCHIVED','RESTORED','TEMPLATE_CREATED','INSTANCE_CREATED','SIGNATURE_CREATED')
  AND length(reason) BETWEEN 8 AND 1000 AND command_hash ~ '^[a-f0-9]{64}$' AND source_fingerprint ~ '^[a-f0-9]{64}$'
  AND jsonb_typeof(before)='object' AND jsonb_typeof(after)='object');

CREATE FUNCTION app_document_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'document history is append-only'; END $$;

CREATE FUNCTION app_document_action_required(organization_uuid uuid,document_uuid uuid,action_key text,actor_uuid uuid,at_time timestamptz,version_uuid uuid DEFAULT NULL)
RETURNS void LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM document_action a JOIN audit_log l ON l.organization_id=a.organization_id AND l.resource_id=a.id
    AND l.resource_type='document' AND l.action='documents.'||lower(action_key)
    WHERE a.organization_id=organization_uuid AND a.document_id=document_uuid AND a.action=action_key AND a.actor_id=actor_uuid AND a.occurred_at=at_time
    AND (version_uuid IS NULL OR a.after->>(CASE WHEN action_key='ADMITTED' THEN 'admissionId' ELSE 'versionId' END)=version_uuid::text)
    AND l.actor_id=a.actor_id AND l.occurred_at=a.occurred_at AND l.after->>'documentId'=a.document_id::text
    AND l.after->>'commandHash'=a.command_hash AND a.xmin::text=pg_current_xact_id()::xid::text AND l.xmin::text=a.xmin::text)
  THEN RAISE EXCEPTION 'document mutation requires atomic private history and canonical audit'; END IF;
END $$;

CREATE FUNCTION app_guard_document_root() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE action_key text;
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'documents cannot be hard-deleted'; END IF;
  IF TG_OP='UPDATE' THEN
    IF (to_jsonb(NEW)-ARRAY['title','privacy','revision','archived_at']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['title','privacy','revision','archived_at'])
      OR NEW.revision<>OLD.revision+1 OR NOT NEW.privacy@>OLD.privacy OR (NEW.title=OLD.title AND NEW.privacy=OLD.privacy AND NEW.archived_at IS NOT DISTINCT FROM OLD.archived_at)
    THEN RAISE EXCEPTION 'document original source and protection cannot be rewritten'; END IF;
    IF NOT EXISTS(SELECT 1 FROM document_action a WHERE a.organization_id=NEW.organization_id AND a.document_id=NEW.id
      AND a.before=to_jsonb(OLD) AND a.after->'document'=to_jsonb(NEW) AND a.xmin::text=pg_current_xact_id()::xid::text)
    THEN RAISE EXCEPTION 'document revision requires retained before and after history'; END IF;
    RETURN NULL;
  END IF;
  IF NEW.revision<>1 OR NEW.archived_at IS NOT NULL THEN RAISE EXCEPTION 'document original admission required'; END IF;
  IF NEW.transaction_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM financial_transaction WHERE organization_id=NEW.organization_id AND id=NEW.transaction_id AND sealed)
  THEN RAISE EXCEPTION 'document financial source must be an original sealed journal'; END IF;
  PERFORM app_document_action_required(NEW.organization_id,NEW.id,'CREATED',NEW.created_by,NEW.created_at);
  IF NEW.kind='TEMPLATE' AND NOT EXISTS(SELECT 1 FROM document_template WHERE organization_id=NEW.organization_id AND document_id=NEW.id)
    OR NEW.kind='INSTANCE' AND NOT EXISTS(SELECT 1 FROM document_instance WHERE organization_id=NEW.organization_id AND document_id=NEW.id)
  THEN RAISE EXCEPTION 'document kind requires its native template or instance'; END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER document_root_guard AFTER INSERT OR UPDATE ON document DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app_guard_document_root();
CREATE TRIGGER document_no_delete BEFORE DELETE ON document FOR EACH ROW EXECUTE FUNCTION app_guard_document_root();

CREATE FUNCTION app_guard_document_admission() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE root document%ROWTYPE; rule config_rule%ROWTYPE; type_policy jsonb;
BEGIN
  SELECT * INTO root FROM document WHERE organization_id=NEW.organization_id AND id=NEW.document_id;
  SELECT * INTO rule FROM config_rule WHERE organization_id=NEW.organization_id AND id=(NEW.policy_snapshot->>'id')::uuid;
  SELECT value INTO type_policy FROM jsonb_array_elements(rule.value->'types') WHERE value->>'key'=root.type_key;
  IF rule.id IS NULL OR rule.key<>'documents.archive' OR rule.value IS DISTINCT FROM NEW.policy_snapshot->'value'
    OR rule.version::text IS DISTINCT FROM NEW.policy_snapshot->>'version' OR type_policy IS NULL
    OR NOT coalesce(type_policy->'sources' ? root.source_kind,false) OR NOT coalesce(type_policy->'content_types' ? NEW.content_type,false)
    OR NEW.file_size>(type_policy->>'max_bytes')::int OR NEW.expected_revision<>root.revision
    OR NOT root.privacy@>ARRAY(SELECT jsonb_array_elements_text(type_policy->'privacy'))
    OR NEW.input->>'typeKey' IS DISTINCT FROM root.type_key OR NEW.input->>'kind' IS DISTINCT FROM root.kind
    OR NEW.input->>'locale' IS DISTINCT FROM root.locale OR NEW.input->'source'->>'kind' IS DISTINCT FROM root.source_kind
    OR NEW.input->'source'->>'id' IS DISTINCT FROM root.source_id::text OR NEW.input->>'sha256' IS DISTINCT FROM NEW.sha256
    OR NEW.input->>'contentType' IS DISTINCT FROM NEW.content_type OR (NEW.input->>'fileSize')::int IS DISTINCT FROM NEW.file_size
    OR NEW.input->>'fileName' IS DISTINCT FROM NEW.file_name OR NEW.input->>'idempotencyKey' IS DISTINCT FROM NEW.command_key::text
    OR NEW.input->>'reason' IS DISTINCT FROM NEW.reason
    OR NEW.authorization_cap->>'organizationId' IS DISTINCT FROM NEW.organization_id::text OR NEW.authorization_cap->>'userAccountId' IS DISTINCT FROM NEW.created_by::text
    OR NEW.supersedes_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM document_version WHERE organization_id=NEW.organization_id AND id=NEW.supersedes_id AND document_id=NEW.document_id)
  THEN RAISE EXCEPTION 'document admission requires original scoped source, explicit policy and actor'; END IF;
  PERFORM app_document_action_required(NEW.organization_id,NEW.document_id,'ADMITTED',NEW.created_by,NEW.created_at,NEW.id);
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER document_admission_guard AFTER INSERT ON document_admission DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app_guard_document_admission();

CREATE FUNCTION app_guard_document_version_before() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE admission document_admission%ROWTYPE; root document%ROWTYPE; previous document_version%ROWTYPE;
BEGIN
  SELECT * INTO root FROM document WHERE organization_id=NEW.organization_id AND id=NEW.document_id FOR UPDATE;
  SELECT * INTO admission FROM document_admission WHERE organization_id=NEW.organization_id AND id=NEW.admission_id;
  SELECT * INTO previous FROM document_version WHERE organization_id=NEW.organization_id AND document_id=NEW.document_id ORDER BY number DESC LIMIT 1;
  IF admission.id IS NULL OR admission.document_id<>NEW.document_id OR NEW.created_by<>admission.created_by OR NEW.created_at<admission.created_at
    OR NEW.title IS DISTINCT FROM admission.input->>'title' OR NEW.supersedes_id IS DISTINCT FROM admission.supersedes_id
    OR NEW.effective_from IS DISTINCT FROM (admission.input->>'effectiveFrom')::timestamptz OR admission.expected_revision<>root.revision
    OR NEW.number<>coalesce(previous.number,0)+1 OR NEW.supersedes_id IS DISTINCT FROM previous.id
    OR NEW.cipher_size<=admission.file_size OR NEW.cipher_size>admission.file_size+256 OR root.archived_at IS NOT NULL
  THEN RAISE EXCEPTION 'document version requires its exact admitted object and linear original history'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER document_version_before BEFORE INSERT ON document_version FOR EACH ROW EXECUTE FUNCTION app_guard_document_version_before();
CREATE FUNCTION app_guard_document_version_after() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
  PERFORM app_document_action_required(NEW.organization_id,NEW.document_id,'VERSION_ADDED',NEW.created_by,NEW.created_at,NEW.id); RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER document_version_guard AFTER INSERT ON document_version DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app_guard_document_version_after();

CREATE FUNCTION app_guard_document_related_source() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE root document%ROWTYPE; source_root document%ROWTYPE; version document_version%ROWTYPE; instance document_instance%ROWTYPE;
BEGIN
  IF TG_TABLE_NAME='document_template' THEN
    SELECT * INTO root FROM document WHERE organization_id=NEW.organization_id AND id=NEW.document_id;
    IF root.kind<>'TEMPLATE' OR root.locale<>NEW.locale OR root.created_by<>NEW.created_by THEN RAISE EXCEPTION 'native document template identity required'; END IF;
    PERFORM app_document_action_required(NEW.organization_id,NEW.document_id,'TEMPLATE_CREATED',NEW.created_by,NEW.created_at);
  ELSIF TG_TABLE_NAME='document_instance' THEN
    SELECT * INTO root FROM document WHERE organization_id=NEW.organization_id AND id=NEW.document_id;
    SELECT * INTO version FROM document_version WHERE organization_id=NEW.organization_id AND id=NEW.template_version_id;
    SELECT * INTO source_root FROM document WHERE organization_id=NEW.organization_id AND id=version.document_id;
    IF root.kind<>'INSTANCE' OR source_root.kind<>'TEMPLATE' OR source_root.locale<>root.locale OR root.created_by<>NEW.created_by
      OR source_root.type_key<>root.type_key OR version.id IS NULL OR root.id=source_root.id
    THEN RAISE EXCEPTION 'document instance requires its exact immutable template version'; END IF;
    PERFORM app_document_action_required(NEW.organization_id,NEW.document_id,'INSTANCE_CREATED',NEW.created_by,NEW.created_at);
  ELSIF TG_TABLE_NAME='signature' THEN
    SELECT * INTO instance FROM document_instance WHERE organization_id=NEW.organization_id AND id=NEW.instance_id;
    SELECT * INTO version FROM document_version WHERE organization_id=NEW.organization_id AND id=NEW.document_version_id;
    IF instance.document_id IS DISTINCT FROM version.document_id OR version.id IS NULL
      OR NOT EXISTS(SELECT 1 FROM signature_event WHERE organization_id=NEW.organization_id AND signature_id=NEW.id AND state='DRAFT')
      OR NOT EXISTS(SELECT 1 FROM signature_recipient WHERE organization_id=NEW.organization_id AND signature_id=NEW.id)
    THEN RAISE EXCEPTION 'signature requires original instance, archived version, recipients and draft event'; END IF;
    PERFORM app_document_action_required(NEW.organization_id,version.document_id,'SIGNATURE_CREATED',NEW.requested_by,NEW.requested_at);
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER document_template_guard AFTER INSERT ON document_template DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app_guard_document_related_source();
CREATE CONSTRAINT TRIGGER document_instance_guard AFTER INSERT ON document_instance DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app_guard_document_related_source();
CREATE CONSTRAINT TRIGGER signature_guard AFTER INSERT ON signature DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app_guard_document_related_source();

CREATE FUNCTION app_guard_document_action() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM audit_log l WHERE l.organization_id=NEW.organization_id AND l.resource_id=NEW.id AND l.resource_type='document'
    AND l.action='documents.'||lower(NEW.action) AND l.actor_id=NEW.actor_id AND l.occurred_at=NEW.occurred_at
    AND l.after->>'documentId'=NEW.document_id::text AND l.after->>'commandHash'=NEW.command_hash
    AND l.xmin::text=pg_current_xact_id()::xid::text)
  THEN RAISE EXCEPTION 'each private document action requires its own atomic canonical audit'; END IF; RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER document_action_guard AFTER INSERT ON document_action DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app_guard_document_action();

ALTER TABLE document ENABLE ROW LEVEL SECURITY;
ALTER TABLE document FORCE ROW LEVEL SECURITY;
CREATE POLICY document_tenant_isolation ON document
 USING (organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid)
 WITH CHECK (organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid);

ALTER TABLE document_admission ENABLE ROW LEVEL SECURITY;
ALTER TABLE document_admission FORCE ROW LEVEL SECURITY;
CREATE POLICY document_admission_tenant_isolation ON document_admission
 USING (organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid)
 WITH CHECK (organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid);
CREATE TRIGGER document_admission_append_only BEFORE UPDATE OR DELETE ON document_admission FOR EACH ROW EXECUTE FUNCTION app_document_append_only();

ALTER TABLE document_version ENABLE ROW LEVEL SECURITY;
ALTER TABLE document_version FORCE ROW LEVEL SECURITY;
CREATE POLICY document_version_tenant_isolation ON document_version
 USING (organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid)
 WITH CHECK (organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid);
CREATE TRIGGER document_version_append_only BEFORE UPDATE OR DELETE ON document_version FOR EACH ROW EXECUTE FUNCTION app_document_append_only();

ALTER TABLE document_template ENABLE ROW LEVEL SECURITY;
ALTER TABLE document_template FORCE ROW LEVEL SECURITY;
CREATE POLICY document_template_tenant_isolation ON document_template
 USING (organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid)
 WITH CHECK (organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid);
CREATE TRIGGER document_template_append_only BEFORE UPDATE OR DELETE ON document_template FOR EACH ROW EXECUTE FUNCTION app_document_append_only();

ALTER TABLE document_instance ENABLE ROW LEVEL SECURITY;
ALTER TABLE document_instance FORCE ROW LEVEL SECURITY;
CREATE POLICY document_instance_tenant_isolation ON document_instance
 USING (organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid)
 WITH CHECK (organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid);
CREATE TRIGGER document_instance_append_only BEFORE UPDATE OR DELETE ON document_instance FOR EACH ROW EXECUTE FUNCTION app_document_append_only();

ALTER TABLE signature ENABLE ROW LEVEL SECURITY;
ALTER TABLE signature FORCE ROW LEVEL SECURITY;
CREATE POLICY signature_tenant_isolation ON signature
 USING (organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid)
 WITH CHECK (organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid);
CREATE TRIGGER signature_append_only BEFORE UPDATE OR DELETE ON signature FOR EACH ROW EXECUTE FUNCTION app_document_append_only();

ALTER TABLE signature_recipient ENABLE ROW LEVEL SECURITY;
ALTER TABLE signature_recipient FORCE ROW LEVEL SECURITY;
CREATE POLICY signature_recipient_tenant_isolation ON signature_recipient
 USING (organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid)
 WITH CHECK (organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid);
CREATE TRIGGER signature_recipient_append_only BEFORE UPDATE OR DELETE ON signature_recipient FOR EACH ROW EXECUTE FUNCTION app_document_append_only();

ALTER TABLE signature_event ENABLE ROW LEVEL SECURITY;
ALTER TABLE signature_event FORCE ROW LEVEL SECURITY;
CREATE POLICY signature_event_tenant_isolation ON signature_event
 USING (organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid)
 WITH CHECK (organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid);
CREATE TRIGGER signature_event_append_only BEFORE UPDATE OR DELETE ON signature_event FOR EACH ROW EXECUTE FUNCTION app_document_append_only();

ALTER TABLE document_action ENABLE ROW LEVEL SECURITY;
ALTER TABLE document_action FORCE ROW LEVEL SECURITY;
CREATE POLICY document_action_tenant_isolation ON document_action
 USING (organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid)
 WITH CHECK (organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid);
CREATE TRIGGER document_action_append_only BEFORE UPDATE OR DELETE ON document_action FOR EACH ROW EXECUTE FUNCTION app_document_append_only();

CREATE UNIQUE INDEX signature_one_original_draft ON signature_event(organization_id,signature_id) WHERE state='DRAFT';

-- Catalog migration preserves explicit grants; ordinary operational roles gain no document permission.
DO $$ DECLARE organization_uuid uuid; BEGIN
  FOR organization_uuid IN SELECT id FROM organization LOOP
    PERFORM set_config('app.current_organization_id',organization_uuid::text,true);
    INSERT INTO permission(organization_id,key,resource,action,description)
    SELECT organization_uuid,resource||':'||action,resource,action,action||' '||replace(resource,'_',' ')
    FROM unnest(ARRAY['document','document_template','document_instance','signature']) resource
    CROSS JOIN unnest(ARRAY['view','create','edit','void','approve','reject','assign','validate','export','pay','reconcile','configure','override']) action
    ON CONFLICT(organization_id,key) DO NOTHING;
    INSERT INTO role_permission(organization_id,role_id,permission_id)
    SELECT organization_uuid,r.id,p.id FROM role r JOIN permission p ON p.organization_id=r.organization_id
    WHERE r.organization_id=organization_uuid AND r.key='admin' AND r.is_system AND r.archived_at IS NULL
      AND p.resource IN ('document','document_template','document_instance','signature')
    ON CONFLICT(organization_id,role_id,permission_id) DO NOTHING;
  END LOOP;
END $$;

COMMIT;
