BEGIN;

-- CreateTable
CREATE TABLE "bank_statement_admission" (
    "id" UUID NOT NULL DEFAULT app_uuid_v7(),
    "organization_id" UUID NOT NULL,
    "actor_id" UUID NOT NULL,
    "ledger_account_id" UUID NOT NULL,
    "idempotency_key" UUID NOT NULL,
    "command_hash" CHAR(64) NOT NULL,
    "file_sha256" CHAR(64) NOT NULL,
    "file_size" INTEGER NOT NULL,
    "format" TEXT NOT NULL,
    "encoding" TEXT NOT NULL,
    "storage_key" TEXT NOT NULL,
    "policy_snapshot" JSONB NOT NULL,
    "bank_identity_hash" CHAR(64) NOT NULL,
    "reason" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bank_statement_admission_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bank_statement_import" (
    "id" UUID NOT NULL DEFAULT app_uuid_v7(),
    "organization_id" UUID NOT NULL,
    "admission_id" UUID NOT NULL,
    "normalized_hash" CHAR(64) NOT NULL,
    "row_count" INTEGER NOT NULL,
    "statement" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bank_statement_import_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bank_statement_line" (
    "id" UUID NOT NULL DEFAULT app_uuid_v7(),
    "organization_id" UUID NOT NULL,
    "original_import_id" UUID NOT NULL,
    "ledger_account_id" UUID NOT NULL,
    "identity_hash" CHAR(64) NOT NULL,
    "bank_identity_hash" CHAR(64) NOT NULL,
    "fact_hash" CHAR(64) NOT NULL,
    "external_id" TEXT,
    "corrects_external_id" TEXT,
    "correction_action" TEXT,
    "posted_on" DATE,
    "amount" DECIMAL(18,2),
    "currency" CHAR(3) NOT NULL,
    "source" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bank_statement_line_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bank_statement_evidence" (
    "id" UUID NOT NULL DEFAULT app_uuid_v7(),
    "organization_id" UUID NOT NULL,
    "import_id" UUID NOT NULL,
    "line_id" UUID NOT NULL,
    "source_order" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bank_statement_evidence_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "bank_statement_admission_account_idx" ON "bank_statement_admission"("organization_id", "ledger_account_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "bank_statement_admission_org_id_unique" ON "bank_statement_admission"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "bank_statement_admission_actor_nonce_unique" ON "bank_statement_admission"("organization_id", "actor_id", "idempotency_key");

-- CreateIndex
CREATE INDEX "bank_statement_import_page_idx" ON "bank_statement_import"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "bank_statement_import_org_id_unique" ON "bank_statement_import"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "bank_statement_import_admission_unique" ON "bank_statement_import"("organization_id", "admission_id");

-- CreateIndex
CREATE INDEX "bank_statement_line_account_date_idx" ON "bank_statement_line"("organization_id", "ledger_account_id", "posted_on", "id");

-- CreateIndex
CREATE INDEX "bank_statement_line_correction_idx" ON "bank_statement_line"("organization_id", "bank_identity_hash", "corrects_external_id");

-- CreateIndex
CREATE UNIQUE INDEX "bank_statement_line_org_id_unique" ON "bank_statement_line"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "bank_statement_line_identity_unique" ON "bank_statement_line"("organization_id", "identity_hash");

-- CreateIndex
CREATE INDEX "bank_statement_evidence_line_idx" ON "bank_statement_evidence"("organization_id", "line_id");

-- CreateIndex
CREATE UNIQUE INDEX "bank_statement_evidence_order_unique" ON "bank_statement_evidence"("organization_id", "import_id", "source_order");

-- CreateIndex
CREATE UNIQUE INDEX "bank_statement_evidence_line_unique" ON "bank_statement_evidence"("organization_id", "import_id", "line_id");

-- AddForeignKey
ALTER TABLE "bank_statement_admission" ADD CONSTRAINT "bank_statement_admission_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "bank_statement_admission" ADD CONSTRAINT "bank_statement_admission_organization_id_actor_id_fkey" FOREIGN KEY ("organization_id", "actor_id") REFERENCES "user_account"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "bank_statement_admission" ADD CONSTRAINT "bank_statement_admission_organization_id_ledger_account_id_fkey" FOREIGN KEY ("organization_id", "ledger_account_id") REFERENCES "ledger_account"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "bank_statement_import" ADD CONSTRAINT "bank_statement_import_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "bank_statement_import" ADD CONSTRAINT "bank_statement_import_organization_id_admission_id_fkey" FOREIGN KEY ("organization_id", "admission_id") REFERENCES "bank_statement_admission"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "bank_statement_line" ADD CONSTRAINT "bank_statement_line_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "bank_statement_line" ADD CONSTRAINT "bank_statement_line_organization_id_original_import_id_fkey" FOREIGN KEY ("organization_id", "original_import_id") REFERENCES "bank_statement_import"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "bank_statement_line" ADD CONSTRAINT "bank_statement_line_organization_id_ledger_account_id_fkey" FOREIGN KEY ("organization_id", "ledger_account_id") REFERENCES "ledger_account"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "bank_statement_evidence" ADD CONSTRAINT "bank_statement_evidence_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "bank_statement_evidence" ADD CONSTRAINT "bank_statement_evidence_organization_id_import_id_fkey" FOREIGN KEY ("organization_id", "import_id") REFERENCES "bank_statement_import"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "bank_statement_evidence" ADD CONSTRAINT "bank_statement_evidence_organization_id_line_id_fkey" FOREIGN KEY ("organization_id", "line_id") REFERENCES "bank_statement_line"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;


ALTER TABLE bank_statement_admission ADD CONSTRAINT bank_statement_admission_values CHECK (
 format IN ('CSV','OFX') AND encoding IN ('UTF-8','WINDOWS-1252') AND file_size BETWEEN 1 AND 10485760
 AND command_hash ~ '^[a-f0-9]{64}$' AND file_sha256 ~ '^[a-f0-9]{64}$' AND bank_identity_hash ~ '^[a-f0-9]{64}$'
 AND length(trim(reason)) BETWEEN 8 AND 2000);
ALTER TABLE bank_statement_import ADD CONSTRAINT bank_statement_import_values CHECK (row_count BETWEEN 0 AND 5000 AND normalized_hash ~ '^[a-f0-9]{64}$');
ALTER TABLE bank_statement_line ADD CONSTRAINT bank_statement_line_values CHECK (
 identity_hash ~ '^[a-f0-9]{64}$' AND fact_hash ~ '^[a-f0-9]{64}$' AND bank_identity_hash ~ '^[a-f0-9]{64}$'
 AND (external_id IS NULL OR length(external_id) BETWEEN 1 AND 255)
 AND ((corrects_external_id IS NULL AND correction_action IS NULL) OR (corrects_external_id IS NOT NULL AND correction_action IS NOT NULL AND length(corrects_external_id) BETWEEN 1 AND 255 AND correction_action IN ('REPLACE','DELETE')))
 AND (corrects_external_id IS NULL OR corrects_external_id IS DISTINCT FROM external_id)
 AND (correction_action IS NOT DISTINCT FROM 'DELETE' OR (amount IS NOT NULL AND posted_on IS NOT NULL)));
ALTER TABLE bank_statement_evidence ADD CONSTRAINT bank_statement_evidence_values CHECK (source_order BETWEEN 1 AND 5000);

ALTER TABLE bank_statement_admission ENABLE ROW LEVEL SECURITY;
ALTER TABLE bank_statement_admission FORCE ROW LEVEL SECURITY;
CREATE POLICY bank_statement_admission_tenant_isolation ON bank_statement_admission USING (organization_id=current_setting('app.current_organization_id',true)::uuid) WITH CHECK (organization_id=current_setting('app.current_organization_id',true)::uuid);
ALTER TABLE bank_statement_import ENABLE ROW LEVEL SECURITY;
ALTER TABLE bank_statement_import FORCE ROW LEVEL SECURITY;
CREATE POLICY bank_statement_import_tenant_isolation ON bank_statement_import USING (organization_id=current_setting('app.current_organization_id',true)::uuid) WITH CHECK (organization_id=current_setting('app.current_organization_id',true)::uuid);
ALTER TABLE bank_statement_line ENABLE ROW LEVEL SECURITY;
ALTER TABLE bank_statement_line FORCE ROW LEVEL SECURITY;
CREATE POLICY bank_statement_line_tenant_isolation ON bank_statement_line USING (organization_id=current_setting('app.current_organization_id',true)::uuid) WITH CHECK (organization_id=current_setting('app.current_organization_id',true)::uuid);
ALTER TABLE bank_statement_evidence ENABLE ROW LEVEL SECURITY;
ALTER TABLE bank_statement_evidence FORCE ROW LEVEL SECURITY;
CREATE POLICY bank_statement_evidence_tenant_isolation ON bank_statement_evidence USING (organization_id=current_setting('app.current_organization_id',true)::uuid) WITH CHECK (organization_id=current_setting('app.current_organization_id',true)::uuid);
CREATE TRIGGER bank_statement_admission_immutable BEFORE UPDATE OR DELETE ON bank_statement_admission FOR EACH ROW EXECUTE FUNCTION app_prevent_ledger_mutation();
CREATE TRIGGER bank_statement_import_immutable BEFORE UPDATE OR DELETE ON bank_statement_import FOR EACH ROW EXECUTE FUNCTION app_prevent_ledger_mutation();
CREATE TRIGGER bank_statement_line_immutable BEFORE UPDATE OR DELETE ON bank_statement_line FOR EACH ROW EXECUTE FUNCTION app_prevent_ledger_mutation();
CREATE TRIGGER bank_statement_evidence_immutable BEFORE UPDATE OR DELETE ON bank_statement_evidence FOR EACH ROW EXECUTE FUNCTION app_prevent_ledger_mutation();

CREATE FUNCTION app_bank_statement_fact_text(f jsonb) RETURNS text LANGUAGE sql IMMUTABLE AS $$
 SELECT '{"externalId":'||COALESCE((f->'externalId')::text,'null')||',"correction":'||
  CASE WHEN f->'correction' IS NULL OR f->'correction'='null'::jsonb THEN 'null' ELSE '{"externalId":'||(f->'correction'->'externalId')::text||',"action":'||(f->'correction'->'action')::text||'}' END||
  ',"postedDate":'||COALESCE((f->'postedDate')::text,'null')||',"sourceTimestamp":'||COALESCE((f->'sourceTimestamp')::text,'null')||',"amount":'||
  CASE WHEN f->'amount' IS NULL OR f->'amount'='null'::jsonb THEN 'null' ELSE '{"amount":'||(f->'amount'->'amount')::text||',"currency":'||(f->'amount'->'currency')::text||'}' END||
  ',"name":'||COALESCE((f->'name')::text,'null')||',"memo":'||COALESCE((f->'memo')::text,'null')||',"reference":'||COALESCE((f->'reference')::text,'null')||',"transactionType":'||COALESCE((f->'transactionType')::text,'null')||'}'
$$;

CREATE FUNCTION app_bank_statement_admission_source_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE policy config_rule; account ledger_account; binding jsonb; selected uuid; identity_text text;
BEGIN
 SELECT * INTO account FROM ledger_account WHERE organization_id=NEW.organization_id AND id=NEW.ledger_account_id;
 SELECT * INTO policy FROM config_rule WHERE organization_id=NEW.organization_id AND id::text=NEW.policy_snapshot->>'id';
 SELECT id INTO selected FROM config_rule WHERE organization_id=NEW.organization_id AND key='finance.bank_statements' AND scope_type='organization' AND scope_id IS NULL
  AND archived_at IS NULL AND lifecycle IN('ACTIVE','RETIRED') AND effective_from<=clock_timestamp() AND(effective_to IS NULL OR effective_to>clock_timestamp())
  ORDER BY effective_from DESC,version DESC LIMIT 1;
 SELECT item INTO binding FROM jsonb_array_elements(policy.value->'accounts') item WHERE item->>'account_code'=account.code;
 identity_text:='['||to_json(binding->>'bank_id')::text||','||COALESCE(to_json(binding->>'branch_id')::text,'null')||','||to_json(binding->>'account_id')::text||']';
 IF account.id IS NULL OR account.archived_at IS NOT NULL OR account.account_type<>'ASSET_LOCATION' OR account.normal_side<>'DEBIT'
  OR EXISTS(SELECT 1 FROM team_wallet w WHERE w.organization_id=NEW.organization_id AND w.ledger_account_id=account.id)
  OR policy.id IS NULL OR policy.id IS DISTINCT FROM selected OR NEW.policy_snapshot->'value' IS DISTINCT FROM policy.value
  OR NEW.policy_snapshot->>'version' IS DISTINCT FROM policy.version::text OR binding IS NULL
  OR policy.value->>'source' IS DISTINCT FROM 'ORIGINAL_BANK_STATEMENT' OR policy.value->>'source_corrections' IS DISTINCT FROM 'APPEND_AND_REOPEN_REVIEW'
  OR policy.value->>'duplicate_csv_without_id' IS DISTINCT FROM 'RETAIN_EVERY_ROW' OR policy.value->'matching'->>'ledger_effect' IS DISTINCT FROM 'NONE'
  OR policy.value->'matching'->>'admission' IS DISTINCT FROM 'EXPLICIT_REVIEW' OR policy.value->>'encoding' IS DISTINCT FROM NEW.encoding
  OR NEW.file_size>(policy.value->>'max_bytes')::integer
  OR (NEW.format='CSV' AND (binding->'csv' IS NULL OR binding->'csv'='null'::jsonb)) OR (NEW.format='OFX' AND binding->>'ofx' IS DISTINCT FROM 'true')
  OR NEW.bank_identity_hash IS DISTINCT FROM encode(digest(convert_to(identity_text,'UTF8'),'sha256'),'hex')
  OR NEW.storage_key IS DISTINCT FROM NEW.organization_id::text||'/finance/bank-statements/'||NEW.id::text||'/'||NEW.file_sha256
 THEN RAISE EXCEPTION 'bank statement admission requires its actual current account and explicit retained source policy'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER bank_statement_admission_source_guard BEFORE INSERT ON bank_statement_admission FOR EACH ROW EXECUTE FUNCTION app_bank_statement_admission_source_guard();

CREATE FUNCTION app_bank_statement_admission_audit_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM audit_log a JOIN bank_statement_admission s ON s.organization_id=a.organization_id AND s.id=a.resource_id
  WHERE s.organization_id=NEW.organization_id AND s.id=NEW.id AND a.xmin=s.xmin AND a.actor_id=s.actor_id AND a.resource_type='bank_statement'
  AND a.action='finance.bank_statement.admitted' AND a.reason=s.reason
  AND a.after->>'admissionId'=s.id::text AND a.after->>'idempotencyKey'=s.idempotency_key::text
  AND a.after->>'commandHash'=s.command_hash AND a.after->>'fileSha256'=s.file_sha256 AND a.after->>'fileSize'=s.file_size::text
  AND a.after->>'ledgerAccountId'=s.ledger_account_id::text AND a.after->>'bankIdentityHash'=s.bank_identity_hash)
 THEN RAISE EXCEPTION 'bank statement admission and its original actor audit must commit atomically'; END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER bank_statement_admission_atomic_audit AFTER INSERT ON bank_statement_admission DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app_bank_statement_admission_audit_guard();

CREATE FUNCTION app_bank_statement_import_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE admission bank_statement_admission; binding jsonb; normalized_text text;
BEGIN
 SELECT * INTO admission FROM bank_statement_admission WHERE organization_id=NEW.organization_id AND id=NEW.admission_id;
 SELECT item INTO binding FROM jsonb_array_elements(admission.policy_snapshot->'value'->'accounts') item JOIN ledger_account a ON a.organization_id=NEW.organization_id AND a.id=admission.ledger_account_id AND item->>'account_code'=a.code;
 SELECT '['||COALESCE(string_agg('{"sourceOrder":'||e.source_order::text||',"factHash":'||to_json(l.fact_hash::text)::text||'}',',' ORDER BY e.source_order),'')||']' INTO normalized_text
  FROM bank_statement_evidence e JOIN bank_statement_line l ON l.organization_id=e.organization_id AND l.id=e.line_id WHERE e.organization_id=NEW.organization_id AND e.import_id=NEW.id;
 IF admission.id IS NULL OR NEW.row_count>(admission.policy_snapshot->'value'->>'max_rows')::integer
  OR NEW.statement->>'bankId' IS DISTINCT FROM binding->>'bank_id' OR NEW.statement->>'branchId' IS DISTINCT FROM binding->>'branch_id'
  OR NEW.statement->>'accountId' IS DISTINCT FROM binding->>'account_id' OR NEW.statement->>'accountType' IS DISTINCT FROM binding->>'account_type'
  OR NEW.statement->>'currency' IS DISTINCT FROM binding->>'currency' OR NEW.statement->>'format' IS DISTINCT FROM admission.format
  OR NEW.normalized_hash IS DISTINCT FROM encode(digest(convert_to(normalized_text,'UTF8'),'sha256'),'hex')
  OR NOT EXISTS(SELECT 1 FROM ledger_account a WHERE a.organization_id=NEW.organization_id AND a.id=admission.ledger_account_id AND a.archived_at IS NULL AND a.account_type='ASSET_LOCATION' AND a.normal_side='DEBIT')
  OR (SELECT count(*) FROM bank_statement_evidence WHERE organization_id=NEW.organization_id AND import_id=NEW.id)<>NEW.row_count
  OR EXISTS(SELECT 1 FROM bank_statement_evidence WHERE organization_id=NEW.organization_id AND import_id=NEW.id AND source_order>NEW.row_count)
  OR NOT EXISTS(SELECT 1 FROM audit_log a JOIN bank_statement_import i ON i.organization_id=a.organization_id AND i.id=a.resource_id
   WHERE i.organization_id=NEW.organization_id AND i.id=NEW.id AND a.xmin=i.xmin AND a.actor_id=admission.actor_id AND a.resource_type='bank_statement'
   AND a.action='finance.bank_statement.imported' AND a.reason=admission.reason AND a.after->>'importId'=NEW.id::text
   AND a.after->>'admissionId'=admission.id::text AND a.after->>'fileSha256'=admission.file_sha256
   AND a.after->>'normalizedHash'=NEW.normalized_hash AND a.after->>'rowCount'=NEW.row_count::text AND a.after->'statement'=NEW.statement)
 THEN RAISE EXCEPTION 'bank statement import requires its complete original source evidence and atomic admission audit'; END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER bank_statement_import_guard AFTER INSERT ON bank_statement_import DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app_bank_statement_import_guard();

CREATE FUNCTION app_bank_statement_line_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE admission bank_statement_admission; binding jsonb; source_order integer; expected_key text; minor integer;
BEGIN
 SELECT a.* INTO admission FROM bank_statement_import i JOIN bank_statement_admission a ON a.organization_id=i.organization_id AND a.id=i.admission_id WHERE i.organization_id=NEW.organization_id AND i.id=NEW.original_import_id;
 SELECT item INTO binding FROM jsonb_array_elements(admission.policy_snapshot->'value'->'accounts') item JOIN ledger_account a ON a.organization_id=NEW.organization_id AND a.id=admission.ledger_account_id AND item->>'account_code'=a.code;
 SELECT e.source_order INTO source_order FROM bank_statement_evidence e WHERE e.organization_id=NEW.organization_id AND e.import_id=NEW.original_import_id AND e.line_id=NEW.id;
 SELECT minor_unit INTO minor FROM currency WHERE code=NEW.currency;
 expected_key:=CASE WHEN NEW.external_id IS NOT NULL THEN '["FITID",'||to_json(NEW.bank_identity_hash::text)::text||','||to_json(NEW.external_id)::text||']'
  ELSE '["CSV",'||to_json(NEW.bank_identity_hash::text)::text||','||to_json(admission.file_sha256::text)::text||','||source_order::text||']' END;
 IF admission.id IS NULL OR source_order IS NULL OR NEW.ledger_account_id<>admission.ledger_account_id OR NEW.bank_identity_hash<>admission.bank_identity_hash
  OR NEW.currency IS DISTINCT FROM binding->>'currency' OR minor IS NULL OR minor>2 OR (NEW.amount IS NOT NULL AND NEW.amount<>round(NEW.amount,minor))
  OR NEW.external_id IS DISTINCT FROM NEW.source->>'externalId' OR NEW.corrects_external_id IS DISTINCT FROM NEW.source->'correction'->>'externalId'
  OR NEW.correction_action IS DISTINCT FROM NEW.source->'correction'->>'action' OR NEW.posted_on::text IS DISTINCT FROM NEW.source->>'postedDate'
  OR NEW.amount IS DISTINCT FROM (NEW.source->'amount'->>'amount')::numeric
  OR jsonb_typeof(NEW.source) IS DISTINCT FROM 'object' OR NOT NEW.source ?& ARRAY['externalId','correction','postedDate','sourceTimestamp','amount','name','memo','reference','transactionType']
  OR (SELECT count(*) FROM jsonb_object_keys(NEW.source))<>9 OR NEW.fact_hash IS DISTINCT FROM encode(digest(convert_to(app_bank_statement_fact_text(NEW.source),'UTF8'),'sha256'),'hex')
  OR (NEW.amount IS NOT NULL AND NEW.currency IS DISTINCT FROM NEW.source->'amount'->>'currency')
  OR NEW.identity_hash IS DISTINCT FROM encode(digest(convert_to(expected_key,'UTF8'),'sha256'),'hex')
 THEN RAISE EXCEPTION 'bank statement line must retain its exact original account, identity, date, currency and Money'; END IF;
 IF NEW.corrects_external_id IS NOT NULL AND EXISTS(WITH RECURSIVE chain(external_id,path) AS (
  SELECT NEW.corrects_external_id,ARRAY[NEW.external_id]::text[] UNION ALL
  SELECT l.corrects_external_id,c.path||c.external_id FROM chain c JOIN bank_statement_line l ON l.organization_id=NEW.organization_id AND l.bank_identity_hash=NEW.bank_identity_hash AND l.external_id=c.external_id
   WHERE l.corrects_external_id IS NOT NULL AND NOT c.external_id=ANY(c.path)
 ) SELECT 1 FROM chain WHERE external_id=NEW.external_id)
 THEN RAISE EXCEPTION 'bank statement corrections must retain an acyclic original source history'; END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER bank_statement_line_guard AFTER INSERT ON bank_statement_line DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app_bank_statement_line_guard();

CREATE FUNCTION app_bank_statement_evidence_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM bank_statement_import i JOIN bank_statement_admission a ON a.organization_id=i.organization_id AND a.id=i.admission_id
  JOIN bank_statement_line l ON l.organization_id=i.organization_id AND l.id=NEW.line_id
  WHERE i.organization_id=NEW.organization_id AND i.id=NEW.import_id AND l.bank_identity_hash=a.bank_identity_hash AND l.ledger_account_id=a.ledger_account_id
   AND NEW.source_order<=i.row_count AND NOT EXISTS(SELECT 1 FROM bank_statement_evidence old WHERE old.organization_id=i.organization_id AND old.import_id=NEW.import_id AND old.line_id=NEW.line_id AND old.id<>NEW.id))
 THEN RAISE EXCEPTION 'bank statement evidence must retain its actual original source account and line'; END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER bank_statement_evidence_guard AFTER INSERT ON bank_statement_evidence DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app_bank_statement_evidence_guard();

COMMIT;
