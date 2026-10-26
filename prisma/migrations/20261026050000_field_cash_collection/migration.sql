-- CreateTable
CREATE TABLE "cash_collection" (
    "id" UUID NOT NULL DEFAULT app_uuid_v7(),
    "organization_id" UUID NOT NULL,
    "task_id" UUID NOT NULL,
    "property_id" UUID NOT NULL,
    "reservation_id" UUID,
    "collector_user_account_id" UUID NOT NULL,
    "collector_person_id" UUID NOT NULL,
    "custody_account_id" UUID NOT NULL,
    "transaction_id" UUID NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "payer" VARCHAR(240) NOT NULL,
    "purpose" VARCHAR(500) NOT NULL,
    "revision" BIGINT NOT NULL,
    "reported_revision" VARCHAR(43) NOT NULL,
    "device_id" VARCHAR(160) NOT NULL,
    "client_op_id" UUID NOT NULL,
    "client_created_at" TIMESTAMPTZ(6),
    "recorded_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "provenance" JSONB NOT NULL,

    CONSTRAINT "cash_collection_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "cash_collection_collector_idx" ON "cash_collection"("organization_id", "collector_user_account_id", "recorded_at", "id");

-- CreateIndex
CREATE UNIQUE INDEX "cash_collection_org_id_unique" ON "cash_collection"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "cash_collection_org_transaction_unique" ON "cash_collection"("organization_id", "transaction_id");

-- CreateIndex
CREATE UNIQUE INDEX "cash_collection_org_operation_unique" ON "cash_collection"("organization_id", "device_id", "client_op_id");

-- CreateIndex
CREATE UNIQUE INDEX "cash_collection_task_revision_unique" ON "cash_collection"("organization_id", "task_id", "revision");

-- CreateIndex
CREATE UNIQUE INDEX "financial_transaction_org_id_unique" ON "financial_transaction"("organization_id", "id");

-- AddForeignKey
ALTER TABLE "cash_collection" ADD CONSTRAINT "cash_collection_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "cash_collection" ADD CONSTRAINT "cash_collection_organization_id_task_id_fkey" FOREIGN KEY ("organization_id", "task_id") REFERENCES "operation_task"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "cash_collection" ADD CONSTRAINT "cash_collection_organization_id_property_id_fkey" FOREIGN KEY ("organization_id", "property_id") REFERENCES "property"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "cash_collection" ADD CONSTRAINT "cash_collection_organization_id_reservation_id_fkey" FOREIGN KEY ("organization_id", "reservation_id") REFERENCES "reservation"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "cash_collection" ADD CONSTRAINT "cash_collection_organization_id_collector_user_account_id_fkey" FOREIGN KEY ("organization_id", "collector_user_account_id") REFERENCES "user_account"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "cash_collection" ADD CONSTRAINT "cash_collection_organization_id_collector_person_id_fkey" FOREIGN KEY ("organization_id", "collector_person_id") REFERENCES "person"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "cash_collection" ADD CONSTRAINT "cash_collection_organization_id_custody_account_id_fkey" FOREIGN KEY ("organization_id", "custody_account_id") REFERENCES "ledger_account"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "cash_collection" ADD CONSTRAINT "cash_collection_organization_id_transaction_id_fkey" FOREIGN KEY ("organization_id", "transaction_id") REFERENCES "financial_transaction"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "cash_collection" ADD CONSTRAINT "cash_collection_currency_fkey" FOREIGN KEY ("currency") REFERENCES "currency"("code") ON DELETE RESTRICT ON UPDATE NO ACTION;

ALTER TABLE cash_collection ADD CONSTRAINT cash_collection_positive_amount CHECK (amount>0);
ALTER TABLE cash_collection ADD CONSTRAINT cash_collection_positive_revision CHECK (revision>0);
ALTER TABLE cash_collection ENABLE ROW LEVEL SECURITY;
ALTER TABLE cash_collection FORCE ROW LEVEL SECURITY;
CREATE POLICY cash_collection_tenant_isolation ON cash_collection
 USING (organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid)
 WITH CHECK (organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid);

CREATE FUNCTION app_cash_collection_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE job operation_task; next_revision bigint; source_snapshot jsonb;
BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'cash collections are append only'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('operation:'||NEW.organization_id::text||':'||NEW.task_id::text,0));
 SELECT * INTO job FROM operation_task WHERE organization_id=NEW.organization_id AND id=NEW.task_id;
 IF NOT FOUND OR job.archived_at IS NOT NULL OR job.state NOT IN ('ASSIGNED','IN_PROGRESS') OR
    ROW(job.property_id,job.reservation_id,job.assigned_to_user_account_id,job.assigned_to_person_id)
      IS DISTINCT FROM ROW(NEW.property_id,NEW.reservation_id,NEW.collector_user_account_id,NEW.collector_person_id) OR
    NEW.provenance->>'taskVersion' IS DISTINCT FROM job.version::text OR NEW.provenance->>'taskType' IS DISTINCT FROM job.type
 THEN RAISE EXCEPTION 'cash collection must retain its assigned task context'; END IF;
 IF NOT EXISTS (SELECT 1 FROM user_account WHERE organization_id=NEW.organization_id AND id=NEW.collector_user_account_id
   AND person_id=NEW.collector_person_id AND status='ACTIVE')
 THEN RAISE EXCEPTION 'cash collector account and person must match'; END IF;
 SELECT count(*)+1 INTO next_revision FROM cash_collection WHERE organization_id=NEW.organization_id AND task_id=NEW.task_id;
 IF NEW.revision<>next_revision THEN RAISE EXCEPTION 'cash collection revision conflict'; END IF;
 SELECT jsonb_build_object('id',id,'version',version,'rules',rules) INTO source_snapshot FROM reservation_financial_snapshot
  WHERE organization_id=NEW.organization_id AND reservation_id=NEW.reservation_id AND jsonb_typeof(rules->'owners')='array'
  ORDER BY version ASC LIMIT 1;
 IF NEW.provenance->'reservationFinancialSnapshot' IS DISTINCT FROM COALESCE(source_snapshot,'null'::jsonb)
 THEN RAISE EXCEPTION 'cash collection must retain the existing reservation financial snapshot'; END IF;
 IF NOT EXISTS (SELECT 1 FROM currency WHERE code=NEW.currency AND minor_unit<=2 AND NEW.amount=round(NEW.amount,minor_unit))
 THEN RAISE EXCEPTION 'cash collection currency precision is invalid'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER cash_collection_guard BEFORE INSERT OR UPDATE OR DELETE ON cash_collection
 FOR EACH ROW EXECUTE FUNCTION app_cash_collection_guard();

CREATE FUNCTION app_cash_collection_complete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS (SELECT 1 FROM financial_transaction WHERE organization_id=NEW.organization_id AND id=NEW.transaction_id
  AND created_by=NEW.collector_user_account_id AND occurred_at=NEW.recorded_at)
 THEN RAISE EXCEPTION 'cash collection requires its original financial transaction'; END IF;
 IF (SELECT count(*) FROM posting WHERE organization_id=NEW.organization_id AND transaction_id=NEW.transaction_id)<>2 OR
    NOT EXISTS (SELECT 1 FROM posting p JOIN ledger_account a ON a.organization_id=p.organization_id AND a.id=p.ledger_account_id
      WHERE p.organization_id=NEW.organization_id AND p.transaction_id=NEW.transaction_id AND p.ledger_account_id=NEW.custody_account_id
      AND p.side='DEBIT' AND p.amount=NEW.amount AND p.currency=NEW.currency AND p.bucket='CASH_COLLECTION'
      AND p.dimensions->>'cashCollectionId'=NEW.id::text AND p.dimensions->>'taskId'=NEW.task_id::text
      AND p.dimensions->>'collectorPersonId'=NEW.collector_person_id::text
      AND a.code='CASH_CUSTODY_'||upper(replace(NEW.collector_person_id::text,'-',''))
      AND a.account_type='ASSET_LOCATION' AND a.normal_side='DEBIT' AND a.archived_at IS NULL) OR
    NOT EXISTS (SELECT 1 FROM posting p JOIN ledger_account a ON a.organization_id=p.organization_id AND a.id=p.ledger_account_id
      WHERE p.organization_id=NEW.organization_id AND p.transaction_id=NEW.transaction_id
      AND p.side='CREDIT' AND p.amount=NEW.amount AND p.currency=NEW.currency AND p.bucket='UNALLOCATED_COLLECTION'
      AND p.dimensions->>'cashCollectionId'=NEW.id::text AND p.dimensions->>'taskId'=NEW.task_id::text
      AND a.code='UNALLOCATED_COLLECTIONS' AND a.account_type='CLAIM_OWNERSHIP' AND a.normal_side='CREDIT' AND a.archived_at IS NULL)
 THEN RAISE EXCEPTION 'cash collection requires balanced custody and unallocated postings'; END IF;
 IF NOT EXISTS (SELECT 1 FROM audit_log WHERE organization_id=NEW.organization_id AND resource_id=NEW.id
  AND resource_type='cash_collection' AND action='cash_collection.recorded' AND actor_id=NEW.collector_user_account_id)
 THEN RAISE EXCEPTION 'cash collection audit is required'; END IF;
 IF NOT EXISTS (SELECT 1 FROM outbox_event WHERE organization_id=NEW.organization_id AND type='PaymentReceived'
  AND payload->'payment'->>'id'=NEW.id::text AND idempotency_key='cash:'||NEW.id::text||':received')
 THEN RAISE EXCEPTION 'cash collection payment event must commit atomically'; END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER cash_collection_complete AFTER INSERT ON cash_collection
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app_cash_collection_complete();

