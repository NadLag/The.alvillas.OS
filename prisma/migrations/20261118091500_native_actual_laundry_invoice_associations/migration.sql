-- CreateTable
CREATE TABLE "laundry_actual_invoice" (
    "id" UUID NOT NULL DEFAULT app_uuid_v7(),
    "organization_id" UUID NOT NULL,
    "batch_id" UUID NOT NULL,
    "expected_invoice_id" UUID NOT NULL,
    "invoice_id" UUID NOT NULL,
    "revision_id" UUID NOT NULL,
    "receipt_version_id" UUID NOT NULL,
    "supersedes_id" UUID,
    "operation" VARCHAR(12) NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "total" DECIMAL(65,2) NOT NULL,
    "idempotency_key" UUID NOT NULL,
    "request_hash" CHAR(64) NOT NULL,
    "review_fingerprint" CHAR(64) NOT NULL,
    "source_fingerprint" CHAR(64) NOT NULL,
    "snapshot" JSONB NOT NULL,
    "reason" VARCHAR(500) NOT NULL,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "laundry_actual_invoice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "laundry_actual_invoice_line" (
    "id" UUID NOT NULL DEFAULT app_uuid_v7(),
    "organization_id" UUID NOT NULL,
    "association_id" UUID NOT NULL,
    "invoice_line_id" UUID NOT NULL,

    CONSTRAINT "laundry_actual_invoice_line_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "actual_laundry_batch_idx" ON "laundry_actual_invoice"("organization_id", "batch_id", "id" DESC);

-- CreateIndex
CREATE INDEX "actual_laundry_invoice_idx" ON "laundry_actual_invoice"("organization_id", "invoice_id");

-- CreateIndex
CREATE UNIQUE INDEX "actual_laundry_org_id" ON "laundry_actual_invoice"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "actual_laundry_nonce" ON "laundry_actual_invoice"("organization_id", "idempotency_key");

-- CreateIndex
CREATE UNIQUE INDEX "actual_laundry_successor" ON "laundry_actual_invoice"("organization_id", "supersedes_id");

-- CreateIndex
CREATE INDEX "actual_laundry_original_line_idx" ON "laundry_actual_invoice_line"("organization_id", "invoice_line_id");

-- CreateIndex
CREATE UNIQUE INDEX "actual_laundry_line_org_id" ON "laundry_actual_invoice_line"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "actual_laundry_line_once" ON "laundry_actual_invoice_line"("organization_id", "association_id", "invoice_line_id");

-- AddForeignKey
ALTER TABLE "laundry_actual_invoice" ADD CONSTRAINT "laundry_actual_invoice_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "laundry_actual_invoice" ADD CONSTRAINT "laundry_actual_invoice_organization_id_created_by_fkey" FOREIGN KEY ("organization_id", "created_by") REFERENCES "user_account"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "laundry_actual_invoice" ADD CONSTRAINT "laundry_actual_invoice_organization_id_batch_id_fkey" FOREIGN KEY ("organization_id", "batch_id") REFERENCES "laundry_batch"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "laundry_actual_invoice" ADD CONSTRAINT "laundry_actual_invoice_organization_id_expected_invoice_id_fkey" FOREIGN KEY ("organization_id", "expected_invoice_id") REFERENCES "laundry_expected_invoice"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "laundry_actual_invoice" ADD CONSTRAINT "laundry_actual_invoice_organization_id_invoice_id_fkey" FOREIGN KEY ("organization_id", "invoice_id") REFERENCES "supplier_invoice"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "laundry_actual_invoice" ADD CONSTRAINT "laundry_actual_invoice_organization_id_revision_id_fkey" FOREIGN KEY ("organization_id", "revision_id") REFERENCES "supplier_invoice_revision"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "laundry_actual_invoice" ADD CONSTRAINT "laundry_actual_invoice_organization_id_receipt_version_id_fkey" FOREIGN KEY ("organization_id", "receipt_version_id") REFERENCES "document_version"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "laundry_actual_invoice" ADD CONSTRAINT "laundry_actual_invoice_organization_id_supersedes_id_fkey" FOREIGN KEY ("organization_id", "supersedes_id") REFERENCES "laundry_actual_invoice"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "laundry_actual_invoice" ADD CONSTRAINT "laundry_actual_invoice_currency_fkey" FOREIGN KEY ("currency") REFERENCES "currency"("code") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "laundry_actual_invoice_line" ADD CONSTRAINT "laundry_actual_invoice_line_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "laundry_actual_invoice_line" ADD CONSTRAINT "laundry_actual_invoice_line_organization_id_association_id_fkey" FOREIGN KEY ("organization_id", "association_id") REFERENCES "laundry_actual_invoice"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "laundry_actual_invoice_line" ADD CONSTRAINT "laundry_actual_invoice_line_organization_id_invoice_line_i_fkey" FOREIGN KEY ("organization_id", "invoice_line_id") REFERENCES "supplier_invoice_line"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- These append-only associations annotate existing invoices and original files.
-- Every monetary source and every financial posting remains in its native engine.
ALTER TABLE laundry_actual_invoice ADD CONSTRAINT actual_laundry_shape CHECK(operation IN('LINK','REPLACE','VOID') AND(operation='LINK')=(supersedes_id IS NULL) AND total>=0 AND request_hash~'^[a-f0-9]{64}$' AND review_fingerprint~'^[a-f0-9]{64}$' AND source_fingerprint~'^[a-f0-9]{64}$' AND length(btrim(reason))>=6);
ALTER TABLE laundry_actual_invoice ENABLE ROW LEVEL SECURITY;
ALTER TABLE laundry_actual_invoice FORCE ROW LEVEL SECURITY;
CREATE POLICY laundry_actual_invoice_tenant_isolation ON laundry_actual_invoice USING(organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid) WITH CHECK(organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid);
CREATE TRIGGER actual_laundry_immutable BEFORE UPDATE OR DELETE ON laundry_actual_invoice FOR EACH ROW EXECUTE FUNCTION app_onboarding_append_only();
ALTER TABLE laundry_actual_invoice_line ENABLE ROW LEVEL SECURITY;
ALTER TABLE laundry_actual_invoice_line FORCE ROW LEVEL SECURITY;
CREATE POLICY laundry_actual_invoice_line_tenant_isolation ON laundry_actual_invoice_line USING(organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid) WITH CHECK(organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid);
CREATE TRIGGER actual_laundry_line_immutable BEFORE UPDATE OR DELETE ON laundry_actual_invoice_line FOR EACH ROW EXECUTE FUNCTION app_onboarding_append_only();

CREATE FUNCTION app_actual_laundry_complete() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE p jsonb;d jsonb;a jsonb;original_xid xid;prior laundry_actual_invoice;invoice supplier_invoice;revision supplier_invoice_revision;expected laundry_expected_invoice;batch laundry_batch;receipt document_version;admission document_admission;root document;line_ids uuid[];native_lines jsonb;native_total numeric;claimed_ids uuid[];
BEGIN
 p:=NEW.snapshot;d:=p->'draft';a:=p->'actual';
 SELECT xmin INTO original_xid FROM laundry_actual_invoice WHERE organization_id=NEW.organization_id AND id=NEW.id;
 PERFORM pg_advisory_xact_lock(hashtextextended('actual-laundry-invoice:'||NEW.organization_id::text||':'||NEW.invoice_id::text,0));
 SELECT * INTO invoice FROM supplier_invoice WHERE organization_id=NEW.organization_id AND id=NEW.invoice_id;
 SELECT * INTO revision FROM supplier_invoice_revision WHERE organization_id=NEW.organization_id AND id=NEW.revision_id;
 SELECT * INTO expected FROM laundry_expected_invoice WHERE organization_id=NEW.organization_id AND id=NEW.expected_invoice_id;
 SELECT * INTO batch FROM laundry_batch WHERE organization_id=NEW.organization_id AND id=NEW.batch_id;
 SELECT * INTO receipt FROM document_version WHERE organization_id=NEW.organization_id AND id=NEW.receipt_version_id;
 SELECT * INTO admission FROM document_admission WHERE organization_id=NEW.organization_id AND id=receipt.admission_id; SELECT * INTO root FROM document WHERE organization_id=NEW.organization_id AND id=receipt.document_id;
 IF p->>'schemaVersion' IS DISTINCT FROM '1' OR p->>'organizationId' IS DISTINCT FROM NEW.organization_id::text OR p->>'actorId' IS DISTINCT FROM NEW.created_by::text OR p->>'associationId' IS DISTINCT FROM NEW.id::text OR p->>'idempotencyKey' IS DISTINCT FROM NEW.idempotency_key::text OR p->>'requestHash' IS DISTINCT FROM NEW.request_hash::text OR p->>'reviewFingerprint' IS DISTINCT FROM NEW.review_fingerprint::text OR p->>'sourceFingerprint' IS DISTINCT FROM NEW.source_fingerprint::text OR(p->>'createdAt')::timestamptz IS DISTINCT FROM NEW.created_at OR d->>'batchId' IS DISTINCT FROM NEW.batch_id::text OR d->>'expectedInvoiceId' IS DISTINCT FROM NEW.expected_invoice_id::text OR d->>'operation' IS DISTINCT FROM NEW.operation OR d->>'supersedesId' IS DISTINCT FROM NEW.supersedes_id::text OR d->>'reason' IS DISTINCT FROM NEW.reason OR d->'selection'->>'invoiceId' IS DISTINCT FROM NEW.invoice_id::text OR d->'selection'->>'revisionId' IS DISTINCT FROM NEW.revision_id::text OR d->'selection'->>'receiptVersionId' IS DISTINCT FROM NEW.receipt_version_id::text THEN RAISE EXCEPTION 'actual_laundry_original_command_required';END IF;
 IF invoice.id IS NULL OR revision.id IS NULL OR expected.id IS NULL OR batch.id IS NULL OR receipt.id IS NULL OR admission.id IS NULL OR revision.invoice_id<>invoice.id OR expected.batch_id<>batch.id OR invoice.supplier_id IS DISTINCT FROM batch.supplier_id OR revision.currency<>NEW.currency OR a->'total'->>'currency' IS DISTINCT FROM NEW.currency::text OR(a->'total'->>'amount')::numeric IS DISTINCT FROM NEW.total OR a->'invoice'->>'id' IS DISTINCT FROM invoice.id::text OR a->'invoice'->>'revisionId' IS DISTINCT FROM revision.id::text OR a->'invoice'->>'supplierId' IS DISTINCT FROM invoice.supplier_id::text OR a->'invoice'->>'invoiceNumber' IS DISTINCT FROM revision.invoice_number OR(a->'invoice'->>'revisionVersion')::int IS DISTINCT FROM revision.version OR a->'receipt'->>'versionId' IS DISTINCT FROM receipt.id::text OR a->'receipt'->>'documentId' IS DISTINCT FROM receipt.document_id::text OR a->'receipt'->>'sha256' IS DISTINCT FROM admission.sha256::text OR a->'receipt'->>'contentType' IS DISTINCT FROM admission.content_type OR p->'expected' IS DISTINCT FROM jsonb_build_object('id',expected.id,'batchSequence',expected.batch_sequence,'currency',expected.currency,'total',expected.total::text,'status',expected.status) THEN RAISE EXCEPTION 'actual_laundry_original_sources_required';END IF;
 IF root.id IS NULL OR root.kind<>'FILE' OR NOT('financial'=ANY(root.privacy)) OR a->'receipt'->'source'->>'kind' IS DISTINCT FROM root.source_kind OR a->'receipt'->'source'->>'id' IS DISTINCT FROM root.source_id::text OR a->'receipt'->>'title' IS DISTINCT FROM receipt.title OR NOT(root.source_kind='SUPPLIER' AND root.source_id=invoice.supplier_id OR root.source_kind='RESERVATION' AND root.source_id=batch.reservation_id OR root.source_kind='PROPERTY' AND EXISTS(SELECT 1 FROM inventory_location l WHERE l.organization_id=NEW.organization_id AND l.id IN(batch.source_location_id,batch.outbound_transit_id,batch.laundry_location_id,batch.inbound_transit_id,batch.return_location_id) AND l.property_id=root.source_id UNION ALL SELECT 1 FROM reservation r WHERE r.organization_id=NEW.organization_id AND r.id=batch.reservation_id AND r.property_id=root.source_id)) THEN RAISE EXCEPTION 'actual_laundry_original_receipt_ancestry_required';END IF;
 IF NEW.operation<>'VOID' AND(root.archived_at IS NOT NULL OR invoice.archived_at IS NOT NULL OR invoice.current_revision_id<>revision.id OR(a->'invoice'->>'version')::int IS DISTINCT FROM invoice.version OR a->'invoice'->>'state' IS DISTINCT FROM invoice.state::text OR EXISTS(SELECT 1 FROM document_version v WHERE v.organization_id=NEW.organization_id AND v.supersedes_id=receipt.id)) THEN RAISE EXCEPTION 'actual_laundry_current_original_revision_required';END IF;
 IF NEW.supersedes_id IS NOT NULL THEN
  SELECT * INTO prior FROM laundry_actual_invoice WHERE organization_id=NEW.organization_id AND id=NEW.supersedes_id;
  IF prior.id IS NULL OR prior.batch_id<>NEW.batch_id OR prior.id=NEW.id OR EXISTS(SELECT 1 FROM laundry_actual_invoice n WHERE n.organization_id=NEW.organization_id AND n.supersedes_id=prior.id AND n.id<>NEW.id) THEN RAISE EXCEPTION 'actual_laundry_original_leaf_required';END IF;
  IF NEW.operation='VOID' AND(prior.operation='VOID' OR prior.expected_invoice_id<>NEW.expected_invoice_id OR prior.invoice_id<>NEW.invoice_id OR prior.revision_id<>NEW.revision_id OR prior.receipt_version_id<>NEW.receipt_version_id OR prior.snapshot->'draft'->'selection' IS DISTINCT FROM d->'selection') THEN RAISE EXCEPTION 'actual_laundry_original_void_required';END IF;
 END IF;
 SELECT array_agg(x::uuid ORDER BY x::uuid) INTO line_ids FROM jsonb_array_elements_text(d->'selection'->'lineIds') x;
 IF cardinality(line_ids) NOT BETWEEN 1 AND 100 OR cardinality(line_ids)<>(SELECT count(DISTINCT x) FROM unnest(line_ids) x) THEN RAISE EXCEPTION 'actual_laundry_original_lines_required';END IF;
 SELECT jsonb_agg(jsonb_build_object('id',l.id,'propertyId',l.property_id,'reservationId',l.reservation_id,'category',l.category,'costCenter',l.cost_center,'amount',l.amount::text) ORDER BY l.id),sum(l.amount) INTO native_lines,native_total FROM supplier_invoice_line l WHERE l.organization_id=NEW.organization_id AND l.revision_id=revision.id AND l.id=ANY(line_ids);
 IF native_lines IS DISTINCT FROM a->'lines' OR native_total IS DISTINCT FROM NEW.total THEN RAISE EXCEPTION 'actual_laundry_exact_native_lines_required';END IF;
 IF EXISTS(SELECT 1 FROM supplier_invoice_line l WHERE l.organization_id=NEW.organization_id AND l.id=ANY(line_ids) AND(l.reservation_id IS NOT NULL AND l.reservation_id IS DISTINCT FROM batch.reservation_id OR l.property_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM inventory_location s WHERE s.organization_id=NEW.organization_id AND s.id IN(batch.source_location_id,batch.outbound_transit_id,batch.laundry_location_id,batch.inbound_transit_id,batch.return_location_id) AND s.property_id=l.property_id UNION ALL SELECT 1 FROM reservation r WHERE r.organization_id=NEW.organization_id AND r.id=batch.reservation_id AND r.property_id=l.property_id) OR l.property_id IS NULL AND(EXISTS(SELECT 1 FROM inventory_location s WHERE s.organization_id=NEW.organization_id AND s.id IN(batch.source_location_id,batch.outbound_transit_id,batch.laundry_location_id,batch.inbound_transit_id,batch.return_location_id) AND s.property_id IS NOT NULL) OR batch.reservation_id IS NOT NULL))) THEN RAISE EXCEPTION 'actual_laundry_original_property_required';END IF;
 SELECT array_agg(invoice_line_id ORDER BY invoice_line_id) INTO claimed_ids FROM laundry_actual_invoice_line WHERE organization_id=NEW.organization_id AND association_id=NEW.id;
 IF NEW.operation='VOID' AND claimed_ids IS NOT NULL OR NEW.operation<>'VOID' AND claimed_ids IS DISTINCT FROM line_ids THEN RAISE EXCEPTION 'actual_laundry_original_line_claims_required';END IF;
 IF NEW.operation<>'VOID' AND EXISTS(SELECT 1 FROM laundry_actual_invoice_line l JOIN laundry_actual_invoice h ON h.organization_id=l.organization_id AND h.id=l.association_id WHERE l.organization_id=NEW.organization_id AND l.invoice_line_id=ANY(line_ids) AND h.id<>NEW.id AND h.operation<>'VOID' AND NOT EXISTS(SELECT 1 FROM laundry_actual_invoice n WHERE n.organization_id=h.organization_id AND n.supersedes_id=h.id)) THEN RAISE EXCEPTION 'actual_laundry_original_line_already_associated';END IF;
 IF NOT EXISTS(SELECT 1 FROM audit_log e WHERE e.organization_id=NEW.organization_id AND e.actor_id=NEW.created_by AND e.resource_type='laundry_actual_invoice' AND e.resource_id=NEW.id AND e.action='laundry.actual_invoice.recorded' AND e.after=p AND e.reason=NEW.reason AND e.xmin=original_xid) OR NOT EXISTS(SELECT 1 FROM outbox_event e WHERE e.organization_id=NEW.organization_id AND e.type='laundry.actual_invoice.recorded' AND e.idempotency_key='laundry-actual-invoice:'||NEW.idempotency_key::text AND e.payload=p AND e.occurred_at=NEW.created_at AND e.xmin=original_xid) THEN RAISE EXCEPTION 'actual_laundry_original_admission_required';END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER actual_laundry_complete AFTER INSERT ON laundry_actual_invoice DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app_actual_laundry_complete();
CREATE FUNCTION app_actual_laundry_line_complete() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM laundry_actual_invoice h JOIN supplier_invoice_line l ON l.organization_id=h.organization_id AND l.revision_id=h.revision_id WHERE h.organization_id=NEW.organization_id AND h.id=NEW.association_id AND h.operation<>'VOID' AND l.id=NEW.invoice_line_id AND h.xmin=(SELECT xmin FROM laundry_actual_invoice_line c WHERE c.organization_id=NEW.organization_id AND c.id=NEW.id)) THEN RAISE EXCEPTION 'actual_laundry_original_line_admission_required';END IF;RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER actual_laundry_line_complete AFTER INSERT ON laundry_actual_invoice_line DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app_actual_laundry_line_complete();
CREATE FUNCTION app_actual_laundry_receipt_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
 IF OLD.idempotency_key LIKE 'laundry-actual-invoice:%' THEN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'actual_laundry_receipt_immutable';END IF;
  IF NEW.id<>OLD.id OR NEW.organization_id<>OLD.organization_id OR NEW.type<>OLD.type OR NEW.idempotency_key<>OLD.idempotency_key OR NEW.payload IS DISTINCT FROM OLD.payload OR NEW.occurred_at<>OLD.occurred_at THEN RAISE EXCEPTION 'actual_laundry_receipt_immutable';END IF;
 END IF;IF TG_OP='DELETE' THEN RETURN OLD;END IF;RETURN NEW;
END $$;
CREATE TRIGGER actual_laundry_receipt_immutable BEFORE UPDATE OR DELETE ON outbox_event FOR EACH ROW EXECUTE FUNCTION app_actual_laundry_receipt_guard();
CREATE FUNCTION app_actual_laundry_receipt_complete() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE p jsonb;original_xid xid;
BEGIN
 IF NEW.idempotency_key NOT LIKE 'laundry-actual-invoice:%' AND NEW.type NOT IN('laundry.actual_invoice.recorded','laundry.actual_invoice.cancelled') THEN RETURN NULL;END IF;p:=NEW.payload;
 SELECT xmin INTO original_xid FROM outbox_event WHERE organization_id=NEW.organization_id AND id=NEW.id;
 IF p->>'schemaVersion' IS DISTINCT FROM '1' OR p->>'organizationId' IS DISTINCT FROM NEW.organization_id::text OR p->>'actorId' IS NULL OR p->>'idempotencyKey' IS NULL OR NEW.idempotency_key IS DISTINCT FROM 'laundry-actual-invoice:'||(p->>'idempotencyKey') THEN RAISE EXCEPTION 'actual_laundry_original_receipt_required';END IF;
 IF NEW.type='laundry.actual_invoice.recorded' THEN
  IF NOT EXISTS(SELECT 1 FROM laundry_actual_invoice h WHERE h.organization_id=NEW.organization_id AND h.id::text=p->>'associationId' AND h.created_by::text=p->>'actorId' AND h.snapshot=p AND h.created_at=NEW.occurred_at AND h.xmin=original_xid) THEN RAISE EXCEPTION 'actual_laundry_original_record_required';END IF;
 ELSIF NEW.type='laundry.actual_invoice.cancelled' THEN
  IF NOT EXISTS(SELECT 1 FROM audit_log a WHERE a.organization_id=NEW.organization_id AND a.resource_type='laundry_actual_invoice_command' AND a.resource_id::text=p->>'idempotencyKey' AND a.actor_id::text=p->>'actorId' AND a.action=NEW.type AND a.after=p AND a.xmin=original_xid) THEN RAISE EXCEPTION 'actual_laundry_original_negative_receipt_required';END IF;
 ELSE RAISE EXCEPTION 'actual_laundry_original_receipt_type_required';END IF;RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER actual_laundry_receipt_complete AFTER INSERT ON outbox_event DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app_actual_laundry_receipt_complete();
