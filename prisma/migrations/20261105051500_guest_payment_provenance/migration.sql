BEGIN;

-- CreateTable
CREATE TABLE "guest_payment_receipt" (
    "id" UUID NOT NULL DEFAULT app_uuid_v7(),
    "organization_id" UUID NOT NULL,
    "transaction_id" UUID NOT NULL,
    "original_audit_id" UUID NOT NULL,
    "deposit_id" UUID NOT NULL,
    "operation" TEXT NOT NULL,
    "reservation_id" UUID NOT NULL,
    "property_id" UUID NOT NULL,
    "guest_id" UUID NOT NULL,
    "financial_snapshot_id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "liability_account_id" UUID NOT NULL,
    "collector_user_account_id" UUID NOT NULL,
    "collector_person_id" UUID NOT NULL,
    "created_by" UUID NOT NULL,
    "recorded_person_id" UUID NOT NULL,
    "original_collection_id" UUID,
    "amount" DECIMAL(18,2) NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "received_at" TIMESTAMPTZ(6) NOT NULL,
    "provenance" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "guest_payment_receipt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "guest_payment_receipt_owner" (
    "organization_id" UUID NOT NULL,
    "receipt_id" UUID NOT NULL,
    "owner_id" UUID NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "share_bps" INTEGER NOT NULL,

    CONSTRAINT "guest_payment_receipt_owner_pkey" PRIMARY KEY ("organization_id","receipt_id","owner_id")
);

-- CreateIndex
CREATE INDEX "guest_payment_receipt_property_idx" ON "guest_payment_receipt"("organization_id", "property_id", "received_at", "id");

-- CreateIndex
CREATE INDEX "guest_payment_receipt_reservation_idx" ON "guest_payment_receipt"("organization_id", "reservation_id", "received_at", "id");

-- CreateIndex
CREATE UNIQUE INDEX "guest_payment_receipt_org_id_unique" ON "guest_payment_receipt"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "guest_payment_receipt_transaction_unique" ON "guest_payment_receipt"("organization_id", "transaction_id");

-- CreateIndex
CREATE UNIQUE INDEX "guest_payment_receipt_deposit_unique" ON "guest_payment_receipt"("organization_id", "deposit_id");

-- CreateIndex
CREATE UNIQUE INDEX "guest_payment_receipt_owner_order_unique" ON "guest_payment_receipt_owner"("organization_id", "receipt_id", "ordinal");

-- CreateIndex
CREATE UNIQUE INDEX "reservation_financial_snapshot_org_id_unique" ON "reservation_financial_snapshot"("organization_id", "id");

-- AddForeignKey
ALTER TABLE "guest_payment_receipt" ADD CONSTRAINT "guest_payment_receipt_organization_fk" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "guest_payment_receipt" ADD CONSTRAINT "guest_payment_receipt_transaction_fk" FOREIGN KEY ("organization_id", "transaction_id") REFERENCES "financial_transaction"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "guest_payment_receipt" ADD CONSTRAINT "guest_payment_receipt_original_audit_fk" FOREIGN KEY ("organization_id", "original_audit_id") REFERENCES "audit_log"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "guest_payment_receipt" ADD CONSTRAINT "guest_payment_receipt_reservation_fk" FOREIGN KEY ("organization_id", "reservation_id") REFERENCES "reservation"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "guest_payment_receipt" ADD CONSTRAINT "guest_payment_receipt_property_fk" FOREIGN KEY ("organization_id", "property_id") REFERENCES "property"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "guest_payment_receipt" ADD CONSTRAINT "guest_payment_receipt_guest_fk" FOREIGN KEY ("organization_id", "guest_id") REFERENCES "guest"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "guest_payment_receipt" ADD CONSTRAINT "guest_payment_receipt_snapshot_fk" FOREIGN KEY ("organization_id", "financial_snapshot_id") REFERENCES "reservation_financial_snapshot"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "guest_payment_receipt" ADD CONSTRAINT "guest_payment_receipt_account_fk" FOREIGN KEY ("organization_id", "account_id") REFERENCES "ledger_account"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "guest_payment_receipt" ADD CONSTRAINT "guest_payment_receipt_liability_fk" FOREIGN KEY ("organization_id", "liability_account_id") REFERENCES "ledger_account"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "guest_payment_receipt" ADD CONSTRAINT "guest_payment_receipt_collector_account_fk" FOREIGN KEY ("organization_id", "collector_user_account_id") REFERENCES "user_account"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "guest_payment_receipt" ADD CONSTRAINT "guest_payment_receipt_collector_person_fk" FOREIGN KEY ("organization_id", "collector_person_id") REFERENCES "person"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "guest_payment_receipt" ADD CONSTRAINT "guest_payment_receipt_recorder_fk" FOREIGN KEY ("organization_id", "created_by") REFERENCES "user_account"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "guest_payment_receipt" ADD CONSTRAINT "guest_payment_receipt_recorded_person_fk" FOREIGN KEY ("organization_id", "recorded_person_id") REFERENCES "person"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "guest_payment_receipt" ADD CONSTRAINT "guest_payment_receipt_collection_fk" FOREIGN KEY ("organization_id", "original_collection_id") REFERENCES "cash_collection"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "guest_payment_receipt" ADD CONSTRAINT "guest_payment_receipt_currency_fk" FOREIGN KEY ("currency") REFERENCES "currency"("code") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "guest_payment_receipt_owner" ADD CONSTRAINT "guest_payment_owner_organization_fk" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "guest_payment_receipt_owner" ADD CONSTRAINT "guest_payment_owner_receipt_fk" FOREIGN KEY ("organization_id", "receipt_id") REFERENCES "guest_payment_receipt"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "guest_payment_receipt_owner" ADD CONSTRAINT "guest_payment_owner_owner_fk" FOREIGN KEY ("organization_id", "owner_id") REFERENCES "owner"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;


-- Immutable receipt metadata and retained owner witnesses; balances remain native movements.
ALTER TABLE guest_payment_receipt ADD CONSTRAINT guest_payment_receipt_positive_money CHECK(amount>0);
ALTER TABLE guest_payment_receipt ADD CONSTRAINT guest_payment_receipt_operation CHECK(operation IN('RECEIPT','ADMIT_CASH'));
ALTER TABLE guest_payment_receipt ADD CONSTRAINT guest_payment_receipt_collection_kind CHECK((operation='ADMIT_CASH')=(original_collection_id IS NOT NULL));
ALTER TABLE guest_payment_receipt ADD CONSTRAINT guest_payment_receipt_distinct_claim CHECK(account_id<>liability_account_id);
ALTER TABLE guest_payment_receipt ADD CONSTRAINT guest_payment_receipt_body CHECK(jsonb_typeof(provenance)='object' AND provenance->'schemaVersion'='1'::jsonb);
ALTER TABLE guest_payment_receipt_owner ADD CONSTRAINT guest_payment_owner_ordinal CHECK(ordinal>=0);
ALTER TABLE guest_payment_receipt_owner ADD CONSTRAINT guest_payment_owner_share CHECK(share_bps BETWEEN 0 AND 10000);

CREATE FUNCTION app_guard_guest_payment_provenance()
RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE
  v_receipt guest_payment_receipt%ROWTYPE;
  v_journal record;
  v_audit audit_log%ROWTYPE;
  v_snapshot reservation_financial_snapshot%ROWTYPE;
  v_booking reservation%ROWTYPE;
  v_cash cash_collection%ROWTYPE;
  v_original jsonb;
  v_expected jsonb;
  v_owners jsonb;
  v_witnesses jsonb;
  v_person uuid;
  v_collection_transaction uuid;
  v_source_time text;
BEGIN
  IF TG_TABLE_NAME='guest_payment_receipt' THEN
    SELECT * INTO v_receipt FROM guest_payment_receipt WHERE organization_id=NEW.organization_id AND id=NEW.id;
  ELSE
    SELECT * INTO v_receipt FROM guest_payment_receipt WHERE organization_id=NEW.organization_id AND id=NEW.receipt_id;
  END IF;
  IF NOT FOUND THEN RAISE EXCEPTION 'original guest payment receipt required'; END IF;
  SELECT t.*,t.xmin::text AS source_xmin INTO v_journal FROM financial_transaction t WHERE organization_id=v_receipt.organization_id AND id=v_receipt.transaction_id;
  IF NOT FOUND OR NOT v_journal.sealed OR v_journal.reverses_transaction_id IS NOT NULL
    OR v_journal.created_by IS DISTINCT FROM v_receipt.created_by
    OR v_journal.reference IS DISTINCT FROM 'GUEST_DEPOSIT:'||v_receipt.deposit_id::text
    OR v_journal.idempotency_key IS DISTINCT FROM 'guest-deposit:'||v_receipt.deposit_id::text
    OR v_journal.source_xmin IS DISTINCT FROM pg_current_xact_id()::xid::text THEN
    RAISE EXCEPTION 'guest payment provenance must accompany its original new sealed receipt';
  END IF;
  SELECT * INTO v_audit FROM audit_log WHERE organization_id=v_receipt.organization_id AND id=v_receipt.original_audit_id;
  IF NOT FOUND OR v_audit.action<>'finance.guest_deposit.received' OR v_audit.resource_type<>'financial_transaction'
    OR v_audit.resource_id IS DISTINCT FROM v_journal.id OR v_audit.actor_id IS DISTINCT FROM v_receipt.created_by
    OR v_audit.after->>'operation' IS DISTINCT FROM v_receipt.operation
    OR NOT EXISTS(SELECT 1 FROM audit_log a WHERE a.organization_id=v_receipt.organization_id AND a.id=v_audit.id AND a.xmin::text=pg_current_xact_id()::xid::text) THEN
    RAISE EXCEPTION 'original attributed guest receipt audit required';
  END IF;
  v_original:=v_audit.after;
  IF v_original#>>'{source,organizationId}' IS DISTINCT FROM v_receipt.organization_id::text
    OR v_original#>>'{source,depositId}' IS DISTINCT FROM v_receipt.deposit_id::text
    OR v_original#>>'{input,idempotencyKey}' IS DISTINCT FROM v_receipt.deposit_id::text
    OR v_original#>>'{source,reservationId}' IS DISTINCT FROM v_receipt.reservation_id::text
    OR v_original#>>'{input,reservationId}' IS DISTINCT FROM v_receipt.reservation_id::text
    OR v_original#>>'{source,propertyId}' IS DISTINCT FROM v_receipt.property_id::text
    OR v_original#>>'{source,guestId}' IS DISTINCT FROM v_receipt.guest_id::text
    OR v_original->>'liabilityAccountId' IS DISTINCT FROM v_receipt.liability_account_id::text
    OR (v_original#>>'{input,amount}')::numeric IS DISTINCT FROM v_receipt.amount
    OR v_original#>>'{input,currency}' IS DISTINCT FROM v_receipt.currency::text
    OR v_audit.reason IS DISTINCT FROM v_original#>>'{input,reason}' THEN
    RAISE EXCEPTION 'guest payment provenance must match the original native financial source';
  END IF;
  SELECT person_id INTO v_person FROM user_account WHERE organization_id=v_receipt.organization_id AND id=v_receipt.created_by;
  IF NOT FOUND OR v_person IS DISTINCT FROM v_receipt.recorded_person_id THEN RAISE EXCEPTION 'original guest payment recording person required'; END IF;
  SELECT * INTO v_booking FROM reservation WHERE organization_id=v_receipt.organization_id AND id=v_receipt.reservation_id;
  IF NOT FOUND OR v_booking.property_id IS DISTINCT FROM v_receipt.property_id OR v_booking.guest_id IS DISTINCT FROM v_receipt.guest_id THEN
    RAISE EXCEPTION 'original guest payment booking parties required';
  END IF;
  IF v_receipt.operation='ADMIT_CASH' THEN
    SELECT * INTO v_cash FROM cash_collection WHERE organization_id=v_receipt.organization_id AND id=v_receipt.original_collection_id;
    IF NOT FOUND OR v_cash.reservation_id IS DISTINCT FROM v_receipt.reservation_id OR v_cash.property_id IS DISTINCT FROM v_receipt.property_id
      OR v_cash.collector_user_account_id IS DISTINCT FROM v_receipt.collector_user_account_id
      OR v_cash.collector_person_id IS DISTINCT FROM v_receipt.collector_person_id
      OR v_cash.custody_account_id IS DISTINCT FROM v_receipt.account_id OR v_cash.recorded_at IS DISTINCT FROM v_receipt.received_at
      OR v_original#>>'{cashSource,id}' IS DISTINCT FROM v_cash.id::text
      OR v_original#>>'{cashSource,transactionId}' IS DISTINCT FROM v_cash.transaction_id::text
      OR v_cash.provenance#>>'{reservationFinancialSnapshot,id}' IS DISTINCT FROM v_receipt.financial_snapshot_id::text
      OR v_original#>>'{cashSource,provenance,reservationFinancialSnapshot,id}' IS DISTINCT FROM v_receipt.financial_snapshot_id::text THEN
      RAISE EXCEPTION 'original guest cash collector, custody and retained booking evidence required';
    END IF;
    v_collection_transaction:=v_cash.transaction_id;
    v_source_time:=v_original#>>'{cashSource,recordedAt}';
  ELSE
    IF v_receipt.collector_user_account_id IS DISTINCT FROM v_receipt.created_by OR v_receipt.collector_person_id IS DISTINCT FROM v_receipt.recorded_person_id
      OR v_original#>>'{input,accountId}' IS DISTINCT FROM v_receipt.account_id::text THEN
      RAISE EXCEPTION 'original direct receipt collector and destination required';
    END IF;
    v_source_time:=v_original#>>'{input,receivedAt}';
    IF v_receipt.financial_snapshot_id IS DISTINCT FROM (SELECT id FROM reservation_financial_snapshot WHERE organization_id=v_receipt.organization_id AND reservation_id=v_receipt.reservation_id ORDER BY version DESC LIMIT 1) THEN
      RAISE EXCEPTION 'current retained booking financial snapshot required at original receipt';
    END IF;
  END IF;
  SELECT * INTO v_snapshot FROM reservation_financial_snapshot WHERE organization_id=v_receipt.organization_id AND id=v_receipt.financial_snapshot_id AND reservation_id=v_receipt.reservation_id;
  IF NOT FOUND OR jsonb_typeof(v_snapshot.rules->'owners') IS DISTINCT FROM 'array' OR jsonb_array_length(v_snapshot.rules->'owners')=0 THEN
    RAISE EXCEPTION 'actual retained financial snapshot owners required';
  END IF;
  IF v_receipt.operation='ADMIT_CASH' AND ((v_cash.provenance#>>'{reservationFinancialSnapshot,version}')::integer IS DISTINCT FROM v_snapshot.version
    OR (v_original#>>'{cashSource,provenance,reservationFinancialSnapshot,version}')::integer IS DISTINCT FROM v_snapshot.version) THEN
    RAISE EXCEPTION 'original cash financial snapshot version required';
  END IF;
  SELECT jsonb_agg(jsonb_build_object('ownerId',(item->>'ownerId')::uuid::text,'shareBps',(item->>'shareBps')::integer) ORDER BY ordinal)
    INTO v_owners FROM jsonb_array_elements(v_snapshot.rules->'owners') WITH ORDINALITY AS original_owner(item,ordinal);
  SELECT jsonb_agg(jsonb_build_object('ownerId',owner_id::text,'shareBps',share_bps) ORDER BY ordinal)
    INTO v_witnesses FROM guest_payment_receipt_owner WHERE organization_id=v_receipt.organization_id AND receipt_id=v_receipt.id;
  IF v_witnesses IS DISTINCT FROM v_owners OR (SELECT coalesce(sum(share_bps),0) FROM guest_payment_receipt_owner WHERE organization_id=v_receipt.organization_id AND receipt_id=v_receipt.id)<>10000
    OR (SELECT coalesce(max(ordinal),-1)+1 FROM guest_payment_receipt_owner WHERE organization_id=v_receipt.organization_id AND receipt_id=v_receipt.id)<>jsonb_array_length(v_owners) THEN
    RAISE EXCEPTION 'complete original ordered owner witnesses required';
  END IF;
  v_expected:=jsonb_build_object('schemaVersion',1,'organizationId',v_receipt.organization_id::text,'transactionId',v_receipt.transaction_id::text,
    'originalAuditId',v_receipt.original_audit_id::text,'depositId',v_receipt.deposit_id::text,'operation',v_receipt.operation,
    'amount',jsonb_build_object('amount',v_receipt.amount::text,'currency',v_receipt.currency::text),
    'recordedBy',jsonb_build_object('userAccountId',v_receipt.created_by::text,'personId',v_receipt.recorded_person_id::text),
    'collectedBy',jsonb_build_object('userAccountId',v_receipt.collector_user_account_id::text,'personId',v_receipt.collector_person_id::text),
    'accountId',v_receipt.account_id::text,'claim',jsonb_build_object('guestId',v_receipt.guest_id::text,'liabilityAccountId',v_receipt.liability_account_id::text),
    'booking',jsonb_build_object('reservationId',v_receipt.reservation_id::text,'propertyId',v_receipt.property_id::text,'guestId',v_receipt.guest_id::text,
      'source',v_booking.source,'financialSnapshotId',v_snapshot.id::text,'financialSnapshotVersion',v_snapshot.version),
    'relatedOwners',v_owners,'purpose',v_original#>>'{input,purpose}','receivedAt',v_source_time,
    'externalReference',CASE WHEN v_receipt.operation='RECEIPT' THEN v_original#>>'{input,externalReference}' ELSE NULL END,
    'originalCollectionId',v_receipt.original_collection_id::text,'originalCollectionTransactionId',v_collection_transaction::text);
  IF v_receipt.provenance IS DISTINCT FROM v_expected OR v_receipt.received_at IS DISTINCT FROM v_source_time::timestamptz THEN
    RAISE EXCEPTION 'complete exact original guest payment provenance required';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM audit_log a WHERE a.organization_id=v_receipt.organization_id AND a.actor_id=v_receipt.created_by
    AND a.action='finance.guest_payment.provenance_retained' AND a.resource_type='financial_transaction' AND a.resource_id=v_receipt.transaction_id
    AND a.after=jsonb_build_object('receiptId',v_receipt.id::text,'provenance',v_receipt.provenance) AND a.reason=v_audit.reason) THEN
    RAISE EXCEPTION 'atomic attributed guest payment provenance audit required';
  END IF;
  RETURN NEW;
END
$$;
CREATE CONSTRAINT TRIGGER guest_payment_receipt_native_guard AFTER INSERT ON guest_payment_receipt DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app_guard_guest_payment_provenance();
CREATE CONSTRAINT TRIGGER guest_payment_owner_native_guard AFTER INSERT ON guest_payment_receipt_owner DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app_guard_guest_payment_provenance();
CREATE TRIGGER guest_payment_receipt_no_update BEFORE UPDATE ON guest_payment_receipt FOR EACH ROW EXECUTE FUNCTION app_prevent_ledger_mutation();
CREATE TRIGGER guest_payment_receipt_no_delete BEFORE DELETE ON guest_payment_receipt FOR EACH ROW EXECUTE FUNCTION app_prevent_ledger_mutation();
CREATE TRIGGER guest_payment_owner_no_update BEFORE UPDATE ON guest_payment_receipt_owner FOR EACH ROW EXECUTE FUNCTION app_prevent_ledger_mutation();
CREATE TRIGGER guest_payment_owner_no_delete BEFORE DELETE ON guest_payment_receipt_owner FOR EACH ROW EXECUTE FUNCTION app_prevent_ledger_mutation();
ALTER TABLE guest_payment_receipt ENABLE ROW LEVEL SECURITY;
ALTER TABLE guest_payment_receipt FORCE ROW LEVEL SECURITY;
CREATE POLICY guest_payment_receipt_tenant_isolation ON guest_payment_receipt USING(organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid) WITH CHECK(organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid);
ALTER TABLE guest_payment_receipt_owner ENABLE ROW LEVEL SECURITY;
ALTER TABLE guest_payment_receipt_owner FORCE ROW LEVEL SECURITY;
CREATE POLICY guest_payment_owner_tenant_isolation ON guest_payment_receipt_owner USING(organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid) WITH CHECK(organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid);


CREATE FUNCTION app_require_guest_payment_provenance()
RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
  IF NEW.reference LIKE 'GUEST_DEPOSIT:%' AND NEW.sealed AND NOT EXISTS(
    SELECT 1 FROM guest_payment_receipt p WHERE p.organization_id=NEW.organization_id AND p.transaction_id=NEW.id
  ) THEN RAISE EXCEPTION 'complete original guest payment provenance required'; END IF;
  RETURN NEW;
END
$$;
CREATE CONSTRAINT TRIGGER guest_payment_provenance_required AFTER INSERT OR UPDATE ON financial_transaction DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app_require_guest_payment_provenance();

COMMIT;
