BEGIN;
-- CreateTable
CREATE TABLE "financial_attachment_admission" (
    "id" UUID NOT NULL DEFAULT app_uuid_v7(),
    "organization_id" UUID NOT NULL,
    "transaction_id" UUID NOT NULL,
    "idempotency_key" UUID NOT NULL,
    "supersedes_id" UUID,
    "kind" VARCHAR(16) NOT NULL,
    "file_name" VARCHAR(180) NOT NULL,
    "content_type" VARCHAR(40) NOT NULL,
    "file_size" INTEGER NOT NULL,
    "sha256" CHAR(64) NOT NULL,
    "reason" VARCHAR(1000) NOT NULL,
    "request_fingerprint" CHAR(64) NOT NULL,
    "source_fingerprint" CHAR(64) NOT NULL,
    "policy_rule_id" UUID NOT NULL,
    "policy_snapshot" JSONB NOT NULL,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "financial_attachment_admission_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "financial_attachment" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "transaction_id" UUID NOT NULL,
    "root_id" UUID NOT NULL,
    "supersedes_id" UUID,
    "version" INTEGER NOT NULL,
    "storage_key" VARCHAR(300) NOT NULL,
    "cipher_size" INTEGER NOT NULL,
    "cipher_sha256" CHAR(64) NOT NULL,
    "key_version" VARCHAR(180) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "financial_attachment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "financial_attachment_admission_organization_id_transaction__idx" ON "financial_attachment_admission"("organization_id", "transaction_id", "created_at", "id");

-- CreateIndex
CREATE UNIQUE INDEX "financial_attachment_admission_organization_id_id_key" ON "financial_attachment_admission"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "financial_attachment_admission_organization_id_created_by_i_key" ON "financial_attachment_admission"("organization_id", "created_by", "idempotency_key");

-- CreateIndex
CREATE INDEX "financial_attachment_organization_id_transaction_id_id_idx" ON "financial_attachment"("organization_id", "transaction_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "financial_attachment_organization_id_id_key" ON "financial_attachment"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "financial_attachment_organization_id_supersedes_id_key" ON "financial_attachment"("organization_id", "supersedes_id");

-- CreateIndex
CREATE UNIQUE INDEX "financial_attachment_organization_id_root_id_version_key" ON "financial_attachment"("organization_id", "root_id", "version");

-- CreateIndex
CREATE UNIQUE INDEX "financial_attachment_organization_id_storage_key_key" ON "financial_attachment"("organization_id", "storage_key");

-- AddForeignKey
ALTER TABLE "financial_attachment_admission" ADD CONSTRAINT "financial_attachment_admission_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "financial_attachment_admission" ADD CONSTRAINT "financial_attachment_admission_organization_id_transaction_fkey" FOREIGN KEY ("organization_id", "transaction_id") REFERENCES "financial_transaction"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "financial_attachment_admission" ADD CONSTRAINT "financial_attachment_admission_organization_id_created_by_fkey" FOREIGN KEY ("organization_id", "created_by") REFERENCES "user_account"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "financial_attachment_admission" ADD CONSTRAINT "financial_attachment_admission_organization_id_policy_rule_fkey" FOREIGN KEY ("organization_id", "policy_rule_id") REFERENCES "config_rule"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "financial_attachment_admission" ADD CONSTRAINT "financial_attachment_admission_organization_id_supersedes__fkey" FOREIGN KEY ("organization_id", "supersedes_id") REFERENCES "financial_attachment"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "financial_attachment" ADD CONSTRAINT "financial_attachment_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "financial_attachment" ADD CONSTRAINT "financial_attachment_organization_id_transaction_id_fkey" FOREIGN KEY ("organization_id", "transaction_id") REFERENCES "financial_transaction"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "financial_attachment" ADD CONSTRAINT "financial_attachment_organization_id_id_fkey" FOREIGN KEY ("organization_id", "id") REFERENCES "financial_attachment_admission"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "financial_attachment" ADD CONSTRAINT "financial_attachment_organization_id_root_id_fkey" FOREIGN KEY ("organization_id", "root_id") REFERENCES "financial_attachment"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "financial_attachment" ADD CONSTRAINT "financial_attachment_organization_id_supersedes_id_fkey" FOREIGN KEY ("organization_id", "supersedes_id") REFERENCES "financial_attachment"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;


ALTER TABLE financial_attachment_admission ADD CONSTRAINT financial_attachment_admission_shape CHECK (
 kind IN ('RECEIPT','INVOICE') AND content_type IN ('application/pdf','image/jpeg','image/png','image/webp')
 AND file_size BETWEEN 1 AND 52428800 AND sha256 ~ '^[a-f0-9]{64}$'
 AND request_fingerprint ~ '^[a-f0-9]{64}$' AND source_fingerprint ~ '^[a-f0-9]{64}$'
 AND length(reason) BETWEEN 6 AND 1000 AND length(file_name) BETWEEN 1 AND 180
 AND file_name !~ '[[:cntrl:]/\\]' AND expires_at>created_at AND expires_at<=created_at+interval '1 day');
ALTER TABLE financial_attachment ADD CONSTRAINT financial_attachment_shape CHECK (
 version>0 AND cipher_size>0 AND cipher_sha256 ~ '^[a-f0-9]{64}$' AND length(key_version)>0
 AND ((supersedes_id IS NULL AND root_id=id AND version=1) OR (supersedes_id IS NOT NULL AND root_id<>id AND version>1)));

CREATE FUNCTION app_financial_attachment_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'financial_attachment_append_only'; END $$;
CREATE TRIGGER financial_attachment_admission_immutable BEFORE UPDATE OR DELETE ON financial_attachment_admission
 FOR EACH ROW EXECUTE FUNCTION app_financial_attachment_immutable();
CREATE TRIGGER financial_attachment_immutable BEFORE UPDATE OR DELETE ON financial_attachment
 FOR EACH ROW EXECUTE FUNCTION app_financial_attachment_immutable();

ALTER TABLE financial_attachment_admission ENABLE ROW LEVEL SECURITY;
ALTER TABLE financial_attachment_admission FORCE ROW LEVEL SECURITY;
CREATE POLICY financial_attachment_admission_tenant ON financial_attachment_admission
 USING (organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid)
 WITH CHECK (organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid);
ALTER TABLE financial_attachment ENABLE ROW LEVEL SECURITY;
ALTER TABLE financial_attachment FORCE ROW LEVEL SECURITY;
CREATE POLICY financial_attachment_tenant ON financial_attachment
 USING (organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid)
 WITH CHECK (organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid);

CREATE FUNCTION app_guard_financial_attachment_admission() RETURNS trigger
 LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE rule config_rule%ROWTYPE;
BEGIN
 SELECT * INTO rule FROM config_rule WHERE organization_id=NEW.organization_id AND id=NEW.policy_rule_id;
 IF NOT FOUND OR rule.key<>'finance.transaction_attachments' OR rule.value IS DISTINCT FROM NEW.policy_snapshot->'value'
  OR rule.version::text IS DISTINCT FROM NEW.policy_snapshot->>'version'
  OR rule.id::text IS DISTINCT FROM NEW.policy_snapshot->>'id'
  OR rule.value->>'encryption' IS DISTINCT FROM 'APP_MANAGED_AUTHENTICATED_ENCRYPTION'
  OR rule.value->>'history' IS DISTINCT FROM 'APPEND_ONLY_WITH_RETAINED_SUPERSEDED_FILES'
  OR NOT coalesce(rule.value->'content_types' ? NEW.content_type,false)
  OR NEW.file_size>(rule.value->>'max_bytes')::integer
  OR NEW.expires_at IS DISTINCT FROM NEW.created_at+((rule.value->>'intent_lifetime_seconds')::integer * interval '1 second')
  OR NOT EXISTS(SELECT 1 FROM financial_transaction WHERE organization_id=NEW.organization_id AND id=NEW.transaction_id AND sealed)
 THEN RAISE EXCEPTION 'financial_attachment_original_source_and_policy_required'; END IF;
 IF NEW.supersedes_id IS NOT NULL AND NOT EXISTS(
  SELECT 1 FROM financial_attachment a JOIN financial_attachment_admission i ON i.organization_id=a.organization_id AND i.id=a.id
  WHERE a.organization_id=NEW.organization_id AND a.id=NEW.supersedes_id AND a.transaction_id=NEW.transaction_id AND i.kind=NEW.kind
 ) THEN RAISE EXCEPTION 'financial_attachment_original_version_required'; END IF;
 IF NOT EXISTS(SELECT 1 FROM audit_log a WHERE a.organization_id=NEW.organization_id AND a.resource_type='financial_attachment'
  AND a.resource_id=NEW.id AND a.action='finance.financial_attachment.admitted' AND a.actor_id=NEW.created_by
  AND a.after->>'transactionId'=NEW.transaction_id::text AND a.after->>'requestFingerprint'=NEW.request_fingerprint
  AND a.after->>'sha256'=NEW.sha256 AND a.reason=NEW.reason AND a.occurred_at=NEW.created_at AND a.xmin::text=NEW.xmin::text)
 THEN RAISE EXCEPTION 'financial_attachment_atomic_admission_audit_required'; END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER financial_attachment_admission_guard AFTER INSERT ON financial_attachment_admission
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app_guard_financial_attachment_admission();

CREATE FUNCTION app_guard_financial_attachment() RETURNS trigger
 LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE admission financial_attachment_admission%ROWTYPE; previous financial_attachment%ROWTYPE;
BEGIN
 SELECT * INTO admission FROM financial_attachment_admission WHERE organization_id=NEW.organization_id AND id=NEW.id;
 IF NOT FOUND OR admission.transaction_id<>NEW.transaction_id OR admission.supersedes_id IS DISTINCT FROM NEW.supersedes_id
  OR NEW.created_at<admission.created_at OR NEW.created_at>=admission.expires_at
  OR NEW.cipher_size NOT BETWEEN admission.file_size+1 AND admission.file_size+256
  OR NEW.storage_key IS DISTINCT FROM 'organizations/'||NEW.organization_id::text||'/financial-transactions/'||NEW.transaction_id::text||'/attachments/'||NEW.id::text||'.encrypted'
 THEN RAISE EXCEPTION 'financial_attachment_exact_admitted_object_required'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(NEW.organization_id::text||':financial-attachment:'||NEW.transaction_id::text,0));
 IF NEW.supersedes_id IS NOT NULL THEN
  SELECT * INTO previous FROM financial_attachment WHERE organization_id=NEW.organization_id AND id=NEW.supersedes_id;
  IF NOT FOUND OR previous.transaction_id<>NEW.transaction_id OR previous.root_id<>NEW.root_id OR previous.version+1<>NEW.version
  THEN RAISE EXCEPTION 'financial_attachment_linear_history_required'; END IF;
 END IF;
 IF NOT EXISTS(SELECT 1 FROM audit_log a WHERE a.organization_id=NEW.organization_id AND a.resource_type='financial_attachment'
  AND a.resource_id=NEW.id AND a.action='finance.financial_attachment.attached' AND a.actor_id=admission.created_by
  AND a.after->>'transactionId'=NEW.transaction_id::text AND a.after->>'rootId'=NEW.root_id::text
  AND a.after->>'version'=NEW.version::text AND a.after->>'sha256'=admission.sha256
  AND a.after->>'cipherSha256'=NEW.cipher_sha256 AND a.reason=admission.reason
  AND a.occurred_at=NEW.created_at AND a.xmin::text=NEW.xmin::text)
 THEN RAISE EXCEPTION 'financial_attachment_atomic_original_file_audit_required'; END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER financial_attachment_guard AFTER INSERT ON financial_attachment
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app_guard_financial_attachment();

COMMIT;
