BEGIN;

-- CreateTable
CREATE TABLE "transaction_group" (
    "id" UUID NOT NULL DEFAULT app_uuid_v7(),
    "organization_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "idempotency_key" UUID NOT NULL,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "transaction_group_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "transaction_group_entry" (
    "id" UUID NOT NULL DEFAULT app_uuid_v7(),
    "organization_id" UUID NOT NULL,
    "group_id" UUID NOT NULL,
    "transaction_id" UUID NOT NULL,
    "previous_entry_id" UUID,
    "action" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "idempotency_key" UUID NOT NULL,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "transaction_group_entry_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "transaction_group_org_id_unique" ON "transaction_group"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "transaction_group_org_key_unique" ON "transaction_group"("organization_id", "idempotency_key");

-- CreateIndex
CREATE INDEX "transaction_group_entry_transaction_idx" ON "transaction_group_entry"("organization_id", "transaction_id");

-- CreateIndex
CREATE INDEX "transaction_group_entry_history_idx" ON "transaction_group_entry"("organization_id", "group_id", "created_at", "id");

-- CreateIndex
CREATE UNIQUE INDEX "transaction_group_entry_org_id_unique" ON "transaction_group_entry"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "transaction_group_entry_org_key_unique" ON "transaction_group_entry"("organization_id", "idempotency_key");

-- CreateIndex
CREATE UNIQUE INDEX "transaction_group_entry_next_unique" ON "transaction_group_entry"("organization_id", "previous_entry_id");

-- Nullable predecessor keys allow exactly one initial entry per transaction.
CREATE UNIQUE INDEX transaction_group_entry_root_unique ON transaction_group_entry(organization_id,transaction_id) WHERE previous_entry_id IS NULL;

-- AddForeignKey
ALTER TABLE "transaction_group" ADD CONSTRAINT "transaction_group_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "transaction_group" ADD CONSTRAINT "transaction_group_organization_id_created_by_fkey" FOREIGN KEY ("organization_id", "created_by") REFERENCES "user_account"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "transaction_group_entry" ADD CONSTRAINT "transaction_group_entry_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "transaction_group_entry" ADD CONSTRAINT "transaction_group_entry_organization_id_group_id_fkey" FOREIGN KEY ("organization_id", "group_id") REFERENCES "transaction_group"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "transaction_group_entry" ADD CONSTRAINT "transaction_group_entry_organization_id_transaction_id_fkey" FOREIGN KEY ("organization_id", "transaction_id") REFERENCES "financial_transaction"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "transaction_group_entry" ADD CONSTRAINT "transaction_group_entry_organization_id_created_by_fkey" FOREIGN KEY ("organization_id", "created_by") REFERENCES "user_account"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "transaction_group_entry" ADD CONSTRAINT "transaction_group_entry_organization_id_previous_entry_id_fkey" FOREIGN KEY ("organization_id", "previous_entry_id") REFERENCES "transaction_group_entry"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

ALTER TABLE transaction_group ADD CONSTRAINT transaction_group_name_check CHECK (length(btrim(name)) BETWEEN 1 AND 120);
ALTER TABLE transaction_group ADD CONSTRAINT transaction_group_reason_check CHECK (length(btrim(reason)) BETWEEN 6 AND 500);
ALTER TABLE transaction_group_entry ADD CONSTRAINT transaction_group_entry_action_check CHECK (action IN ('ATTACH','DETACH'));
ALTER TABLE transaction_group_entry ADD CONSTRAINT transaction_group_entry_reason_check CHECK (length(btrim(reason)) BETWEEN 6 AND 500);

ALTER TABLE transaction_group ENABLE ROW LEVEL SECURITY;
ALTER TABLE transaction_group FORCE ROW LEVEL SECURITY;
CREATE POLICY transaction_group_tenant_isolation ON transaction_group
 USING (organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid)
 WITH CHECK (organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid);
ALTER TABLE transaction_group_entry ENABLE ROW LEVEL SECURITY;
ALTER TABLE transaction_group_entry FORCE ROW LEVEL SECURITY;
CREATE POLICY transaction_group_entry_tenant_isolation ON transaction_group_entry
 USING (organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid)
 WITH CHECK (organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid);

CREATE TRIGGER transaction_group_immutable BEFORE UPDATE OR DELETE ON transaction_group
 FOR EACH ROW EXECUTE FUNCTION app_prevent_ledger_mutation();
CREATE TRIGGER transaction_group_entry_immutable BEFORE UPDATE OR DELETE ON transaction_group_entry
 FOR EACH ROW EXECUTE FUNCTION app_prevent_ledger_mutation();

-- The journal itself is never updated. A transaction has one current membership
-- chain; removing or moving it appends a reasoned successor to that history.
CREATE FUNCTION app_transaction_group_entry_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE previous transaction_group_entry%ROWTYPE;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended(NEW.organization_id::text||':transaction-group:'||NEW.transaction_id::text,0));
 SELECT e.* INTO previous FROM transaction_group_entry e
 WHERE e.organization_id=NEW.organization_id AND e.transaction_id=NEW.transaction_id
  AND NOT EXISTS (SELECT 1 FROM transaction_group_entry n WHERE n.organization_id=e.organization_id AND n.previous_entry_id=e.id);
 IF NEW.previous_entry_id IS DISTINCT FROM previous.id THEN
  RAISE EXCEPTION 'transaction group membership has changed';
 END IF;
 IF NEW.action='ATTACH' THEN
  IF previous.action='ATTACH' THEN RAISE EXCEPTION 'transaction already belongs to a group'; END IF;
 ELSIF NEW.action='DETACH' THEN
  IF previous.id IS NULL OR previous.action<>'ATTACH' OR previous.group_id<>NEW.group_id THEN
   RAISE EXCEPTION 'transaction is not a current member of this group';
  END IF;
 END IF;
 NEW.created_at:=clock_timestamp();
 RETURN NEW;
END $$;
CREATE TRIGGER transaction_group_entry_chain BEFORE INSERT ON transaction_group_entry
 FOR EACH ROW EXECUTE FUNCTION app_transaction_group_entry_guard();

CREATE FUNCTION app_transaction_group_audit_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_TABLE_NAME='transaction_group' THEN
  IF NOT EXISTS (SELECT 1 FROM audit_log a WHERE a.organization_id=NEW.organization_id AND a.resource_type='transaction_group'
    AND a.resource_id=NEW.id AND a.actor_id=NEW.created_by AND a.action='finance.group.created' AND a.reason=NEW.reason
    AND a.after->>'name'=NEW.name) THEN RAISE EXCEPTION 'transaction group audit must commit atomically'; END IF;
 ELSE
  IF NOT EXISTS (SELECT 1 FROM audit_log a WHERE a.organization_id=NEW.organization_id AND a.resource_type='transaction_group'
    AND a.resource_id=NEW.group_id AND a.actor_id=NEW.created_by AND a.action=CASE WHEN NEW.action='ATTACH' THEN 'finance.group.attached' ELSE 'finance.group.detached' END
    AND a.reason=NEW.reason AND a.after->>'entryId'=NEW.id::text AND a.after->>'transactionId'=NEW.transaction_id::text)
  THEN RAISE EXCEPTION 'transaction group membership audit must commit atomically'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER transaction_group_audit AFTER INSERT ON transaction_group
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app_transaction_group_audit_guard();
CREATE CONSTRAINT TRIGGER transaction_group_entry_audit AFTER INSERT ON transaction_group_entry
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app_transaction_group_audit_guard();

COMMIT;

