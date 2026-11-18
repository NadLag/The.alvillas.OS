-- CreateTable
CREATE TABLE "laundry_expected_invoice" (
    "id" UUID NOT NULL DEFAULT app_uuid_v7(),
    "organization_id" UUID NOT NULL,
    "batch_id" UUID NOT NULL,
    "quote_version_id" UUID NOT NULL,
    "pricing_property_id" UUID,
    "price_at" TIMESTAMPTZ(6) NOT NULL,
    "batch_sequence" INTEGER NOT NULL,
    "status" VARCHAR(20) NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "total" DECIMAL(65,2) NOT NULL,
    "source_fingerprint" CHAR(64) NOT NULL,
    "request_hash" CHAR(64) NOT NULL,
    "review_fingerprint" CHAR(64) NOT NULL,
    "idempotency_key" UUID NOT NULL,
    "snapshot" JSONB NOT NULL,
    "reason" VARCHAR(500) NOT NULL,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "laundry_expected_invoice_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "expected_laundry_batch_idx" ON "laundry_expected_invoice"("organization_id", "batch_id", "created_at" DESC, "id" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "expected_laundry_org_id" ON "laundry_expected_invoice"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "expected_laundry_nonce" ON "laundry_expected_invoice"("organization_id", "idempotency_key");

-- AddForeignKey
ALTER TABLE "laundry_expected_invoice" ADD CONSTRAINT "laundry_expected_invoice_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "laundry_expected_invoice" ADD CONSTRAINT "laundry_expected_invoice_organization_id_batch_id_fkey" FOREIGN KEY ("organization_id", "batch_id") REFERENCES "laundry_batch"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "laundry_expected_invoice" ADD CONSTRAINT "laundry_expected_invoice_organization_id_quote_version_id_fkey" FOREIGN KEY ("organization_id", "quote_version_id") REFERENCES "supplier_price_list_version"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "laundry_expected_invoice" ADD CONSTRAINT "laundry_expected_invoice_organization_id_pricing_property__fkey" FOREIGN KEY ("organization_id", "pricing_property_id") REFERENCES "property"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "laundry_expected_invoice" ADD CONSTRAINT "laundry_expected_invoice_organization_id_created_by_fkey" FOREIGN KEY ("organization_id", "created_by") REFERENCES "user_account"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "laundry_expected_invoice" ADD CONSTRAINT "laundry_expected_invoice_currency_fkey" FOREIGN KEY ("currency") REFERENCES "currency"("code") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- Immutable quoted estimates use original custody and the native CFG quote.
-- No financial transaction, supplier invoice or stock movement is created here.
ALTER TABLE laundry_expected_invoice ADD CONSTRAINT expected_laundry_shape CHECK(batch_sequence>=0 AND status IN('READY','PROVISIONAL') AND total>=0 AND source_fingerprint~'^[a-f0-9]{64}$' AND request_hash~'^[a-f0-9]{64}$' AND review_fingerprint~'^[a-f0-9]{64}$' AND length(btrim(reason))>=6);
ALTER TABLE laundry_expected_invoice ENABLE ROW LEVEL SECURITY;
ALTER TABLE laundry_expected_invoice FORCE ROW LEVEL SECURITY;
CREATE POLICY laundry_expected_invoice_tenant_isolation ON laundry_expected_invoice USING(organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid) WITH CHECK(organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid);
CREATE TRIGGER expected_laundry_immutable BEFORE UPDATE OR DELETE ON laundry_expected_invoice FOR EACH ROW EXECUTE FUNCTION app_onboarding_append_only();

CREATE FUNCTION app_expected_laundry_complete() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE p jsonb;d jsonb;source jsonb;quote config_rule;batch laundry_batch;original_xid xid;expected_lines jsonb;expected_usage jsonb;priced_lines jsonb;expected_total numeric;expected_status text;selected_id uuid;closed boolean;stage_basis text;
BEGIN
 p:=NEW.snapshot;d:=p->'draft';source:=p->'source';
 SELECT xmin INTO original_xid FROM laundry_expected_invoice WHERE organization_id=NEW.organization_id AND id=NEW.id;
 SELECT * INTO batch FROM laundry_batch WHERE organization_id=NEW.organization_id AND id=NEW.batch_id;
 SELECT c.* INTO quote FROM supplier_price_list_version v JOIN config_rule c ON c.organization_id=v.organization_id AND c.id=v.config_rule_id WHERE v.organization_id=NEW.organization_id AND v.id=NEW.quote_version_id AND v.supplier_id=batch.supplier_id;
 IF p->>'schemaVersion' IS DISTINCT FROM '1' OR p->>'assessmentId' IS DISTINCT FROM NEW.id::text OR p->>'organizationId' IS DISTINCT FROM NEW.organization_id::text OR p->>'actorId' IS DISTINCT FROM NEW.created_by::text OR p->>'idempotencyKey' IS DISTINCT FROM NEW.idempotency_key::text OR p->>'requestHash' IS DISTINCT FROM NEW.request_hash::text OR p->>'reviewFingerprint' IS DISTINCT FROM NEW.review_fingerprint::text OR p->>'sourceFingerprint' IS DISTINCT FROM NEW.source_fingerprint::text OR (p->>'createdAt')::timestamptz IS DISTINCT FROM NEW.created_at OR (p->>'batchSequence')::int IS DISTINCT FROM NEW.batch_sequence OR d->>'batchId' IS DISTINCT FROM NEW.batch_id::text OR d->>'quoteVersionId' IS DISTINCT FROM NEW.quote_version_id::text OR d->>'pricingPropertyId' IS DISTINCT FROM NEW.pricing_property_id::text OR (d->>'priceAt')::timestamptz IS DISTINCT FROM NEW.price_at OR d->>'reason' IS DISTINCT FROM NEW.reason OR p->'result'->>'currency' IS DISTINCT FROM NEW.currency::text OR (p->'result'->>'total')::numeric IS DISTINCT FROM NEW.total OR p->'result'->>'status' IS DISTINCT FROM NEW.status THEN RAISE EXCEPTION 'expected_laundry_original_snapshot_required';END IF;
 IF batch.id IS NULL OR quote.id IS NULL OR quote.lifecycle<>'ACTIVE' OR quote.value IS DISTINCT FROM p->'policy' OR quote.value->>'currency' IS DISTINCT FROM NEW.currency::text OR jsonb_typeof(quote.value->'billing') IS DISTINCT FROM 'object' OR batch.supplier_id IS NULL OR NEW.batch_sequence IS DISTINCT FROM(SELECT COALESCE(max(e.sequence),0)::int FROM laundry_batch_event e WHERE e.organization_id=NEW.organization_id AND e.batch_id=NEW.batch_id) THEN RAISE EXCEPTION 'expected_laundry_original_quote_and_custody_required';END IF;
 -- This is an admission proof of the native selector, not another price engine.
 WITH eligible AS(SELECT c.*,row_number()OVER(PARTITION BY c.scope_type,c.scope_id ORDER BY c.effective_from DESC,c.version DESC) AS rank FROM config_rule c WHERE c.organization_id=NEW.organization_id AND c.key=quote.key AND c.archived_at IS NULL AND c.lifecycle IN('ACTIVE','RETIRED') AND c.effective_from<=NEW.price_at AND(c.effective_to IS NULL OR c.effective_to>NEW.price_at) AND(c.scope_type='organization' AND c.scope_id IS NULL OR c.scope_type='property' AND c.scope_id=NEW.pricing_property_id)) SELECT id INTO selected_id FROM eligible WHERE rank=1 AND lifecycle='ACTIVE' ORDER BY CASE scope_type WHEN 'property' THEN 1 ELSE 0 END DESC LIMIT 1;
 IF selected_id IS DISTINCT FROM NEW.quote_version_id THEN RAISE EXCEPTION 'expected_laundry_effective_native_quote_required';END IF;
 IF NEW.pricing_property_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM inventory_location l WHERE l.organization_id=NEW.organization_id AND l.id IN(batch.source_location_id,batch.outbound_transit_id,batch.laundry_location_id,batch.inbound_transit_id,batch.return_location_id) AND l.property_id=NEW.pricing_property_id UNION ALL SELECT 1 FROM reservation r WHERE r.organization_id=NEW.organization_id AND r.id=batch.reservation_id AND r.property_id=NEW.pricing_property_id) OR NEW.pricing_property_id IS NULL AND(EXISTS(SELECT 1 FROM inventory_location l WHERE l.organization_id=NEW.organization_id AND l.id IN(batch.source_location_id,batch.outbound_transit_id,batch.laundry_location_id,batch.inbound_transit_id,batch.return_location_id) AND l.property_id IS NOT NULL) OR batch.reservation_id IS NOT NULL) THEN RAISE EXCEPTION 'expected_laundry_actual_property_required';END IF;
 SELECT COALESCE(jsonb_agg(jsonb_build_object('id',l.id,'itemId',l.item_id,'itemKey',i.key,'unit',i.unit,'condition',l.condition,'quantity',l.quantity::text) ORDER BY l.id),'[]'::jsonb) INTO expected_lines FROM laundry_batch_line l JOIN inventory_item i ON i.organization_id=l.organization_id AND i.id=l.item_id WHERE l.organization_id=NEW.organization_id AND l.batch_id=NEW.batch_id;
 WITH usage AS(SELECT c.line_id,CASE e.operation WHEN 'SEND' THEN 'SENT' WHEN 'RECEIVE_LAUNDRY' THEN 'RECEIVED' ELSE 'WASHED' END AS basis,CASE WHEN e.operation='SEND' THEN l.condition WHEN app_laundry_bucket_damaged(c.from_bucket) THEN 'DAMAGED' ELSE 'USABLE' END AS condition,sum(c.quantity)::text AS quantity FROM laundry_batch_change c JOIN laundry_batch_event e ON e.organization_id=c.organization_id AND e.id=c.event_id JOIN laundry_batch_line l ON l.organization_id=c.organization_id AND l.id=c.line_id WHERE e.organization_id=NEW.organization_id AND e.batch_id=NEW.batch_id AND e.sequence<=NEW.batch_sequence AND e.operation IN('SEND','RECEIVE_LAUNDRY','WASH_COMPLETE') AND NOT EXISTS(SELECT 1 FROM laundry_batch_event r WHERE r.organization_id=e.organization_id AND r.reverses_event_id=e.id AND r.sequence<=NEW.batch_sequence) GROUP BY c.line_id,2,3) SELECT COALESCE(jsonb_agg(jsonb_build_object('lineId',line_id,'basis',basis,'condition',condition,'quantity',quantity) ORDER BY line_id,basis,condition),'[]'::jsonb) INTO expected_usage FROM usage;
 SELECT EXISTS(SELECT 1 FROM laundry_batch_event e WHERE e.organization_id=NEW.organization_id AND e.batch_id=NEW.batch_id AND e.operation='CLOSE' AND NOT EXISTS(SELECT 1 FROM laundry_batch_event r WHERE r.organization_id=e.organization_id AND r.reverses_event_id=e.id)) INTO closed;
 IF source->'lines' IS DISTINCT FROM expected_lines OR source->'usage' IS DISTINCT FROM expected_usage OR(source->>'finalized')::boolean IS DISTINCT FROM closed OR EXISTS(SELECT 1 FROM laundry_batch_event e WHERE e.organization_id=NEW.organization_id AND e.batch_id=NEW.batch_id AND e.operation='CANCEL' AND NOT EXISTS(SELECT 1 FROM laundry_batch_event r WHERE r.organization_id=e.organization_id AND r.reverses_event_id=e.id)) THEN RAISE EXCEPTION 'expected_laundry_original_stage_quantities_required';END IF;
 stage_basis:=quote.value->'billing'->>'quantityBasis';
 IF stage_basis NOT IN('PLANNED','SENT','RECEIVED','WASHED') OR jsonb_typeof(quote.value->'billing'->'billableConditions') IS DISTINCT FROM 'array' OR jsonb_array_length(quote.value->'billing'->'billableConditions') NOT BETWEEN 1 AND 2 OR EXISTS(SELECT 1 FROM jsonb_array_elements_text(quote.value->'billing'->'billableConditions') x WHERE x NOT IN('USABLE','DAMAGED')) OR(SELECT count(DISTINCT x) FROM jsonb_array_elements_text(quote.value->'billing'->'billableConditions') x)<>jsonb_array_length(quote.value->'billing'->'billableConditions') THEN RAISE EXCEPTION 'expected_laundry_explicit_billing_terms_required';END IF;
 WITH bill_rows AS(SELECT l,u->>'condition' AS condition,u->>'quantity' AS quantity FROM jsonb_array_elements(expected_lines) l CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN stage_basis='PLANNED' THEN jsonb_build_array(jsonb_build_object('condition',l->>'condition','quantity',l->>'quantity')) ELSE(SELECT COALESCE(jsonb_agg(u),'[]'::jsonb) FROM jsonb_array_elements(expected_usage) u WHERE u->>'lineId'=l->>'id' AND u->>'basis'=stage_basis) END) u),priced AS(SELECT b.*,rate,quote.value->'billing'->'billableConditions' ? b.condition AS billable FROM bill_rows b LEFT JOIN LATERAL(SELECT r AS rate FROM jsonb_array_elements(quote.value->'prices') r WHERE r->>'item'=b.l->>'itemKey') r ON true) SELECT COALESCE(jsonb_agg(jsonb_build_object('lineId',l->>'id','itemId',l->>'itemId','itemKey',l->>'itemKey','condition',condition,'unit',l->>'unit','quantity',quantity,'billable',billable,'unitPrice',rate->>'amount','total',CASE WHEN NOT billable OR quantity::numeric=0 THEN '0.00' WHEN rate IS NULL OR rate->>'unit' IS DISTINCT FROM l->>'unit' THEN NULL ELSE((quantity::numeric*(rate->>'amount')::numeric)::numeric(65,2))::text END,'issue',NULL) ORDER BY l->>'id',condition),'[]'::jsonb) INTO priced_lines FROM priced;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(priced_lines) r WHERE r->>'total' IS NULL) OR p->'result'->'lines' IS DISTINCT FROM priced_lines THEN RAISE EXCEPTION 'expected_laundry_exact_original_rates_required';END IF;
 SELECT COALESCE(sum((r->>'total')::numeric),0) INTO expected_total FROM jsonb_array_elements(priced_lines) r;
 expected_status:='READY';IF NOT closed AND stage_basis<>'PLANNED' AND EXISTS(SELECT 1 FROM jsonb_array_elements(expected_lines) l WHERE COALESCE((SELECT sum((u->>'quantity')::numeric) FROM jsonb_array_elements(expected_usage) u WHERE u->>'lineId'=l->>'id' AND u->>'basis'=stage_basis),0)<(l->>'quantity')::numeric) THEN expected_status:='PROVISIONAL';END IF;
 IF NEW.total IS DISTINCT FROM expected_total OR NEW.status IS DISTINCT FROM expected_status THEN RAISE EXCEPTION 'expected_laundry_exact_total_required';END IF;
 IF NOT EXISTS(SELECT 1 FROM outbox_event e WHERE e.organization_id=NEW.organization_id AND e.idempotency_key='laundry-expected-invoice:'||NEW.idempotency_key::text AND e.type='laundry.expected_invoice.recorded' AND e.payload=p AND e.occurred_at=NEW.created_at AND e.xmin=original_xid) OR NOT EXISTS(SELECT 1 FROM audit_log a WHERE a.organization_id=NEW.organization_id AND a.actor_id=NEW.created_by AND a.resource_type='laundry_expected_invoice' AND a.resource_id=NEW.id AND a.action='laundry.expected_invoice.recorded' AND a.after=p AND a.property_scope_id IS NOT DISTINCT FROM NEW.pricing_property_id AND a.reason=NEW.reason AND a.xmin=original_xid) THEN RAISE EXCEPTION 'expected_laundry_original_admission_proof_required';END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER expected_laundry_complete AFTER INSERT ON laundry_expected_invoice DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app_expected_laundry_complete();

CREATE FUNCTION app_expected_laundry_receipt_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
 IF OLD.idempotency_key LIKE 'laundry-expected-invoice:%' THEN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'expected_laundry_receipt_immutable';END IF;
  IF NEW.id<>OLD.id OR NEW.organization_id<>OLD.organization_id OR NEW.idempotency_key<>OLD.idempotency_key OR NEW.type<>OLD.type OR NEW.payload IS DISTINCT FROM OLD.payload OR NEW.occurred_at<>OLD.occurred_at THEN RAISE EXCEPTION 'expected_laundry_receipt_immutable';END IF;
 END IF;IF TG_OP='DELETE' THEN RETURN OLD;END IF;RETURN NEW;
END $$;
CREATE TRIGGER expected_laundry_receipt_immutable BEFORE UPDATE OR DELETE ON outbox_event FOR EACH ROW EXECUTE FUNCTION app_expected_laundry_receipt_guard();
CREATE FUNCTION app_expected_laundry_receipt_complete() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE p jsonb;original_xid xid;
BEGIN
 IF NEW.idempotency_key NOT LIKE 'laundry-expected-invoice:%' AND NEW.type NOT IN('laundry.expected_invoice.recorded','laundry.expected_invoice.cancelled') THEN RETURN NULL;END IF;
 p:=NEW.payload;SELECT xmin INTO original_xid FROM outbox_event WHERE organization_id=NEW.organization_id AND id=NEW.id;
 IF p->>'schemaVersion' IS DISTINCT FROM '1' OR p->>'organizationId' IS DISTINCT FROM NEW.organization_id::text OR p->>'idempotencyKey' IS NULL OR p->>'actorId' IS NULL OR NEW.idempotency_key IS DISTINCT FROM 'laundry-expected-invoice:'||(p->>'idempotencyKey') THEN RAISE EXCEPTION 'expected_laundry_original_command_required';END IF;
 IF NEW.type='laundry.expected_invoice.recorded' THEN
  IF NOT EXISTS(SELECT 1 FROM laundry_expected_invoice i WHERE i.organization_id=NEW.organization_id AND i.id::text=p->>'assessmentId' AND i.created_by::text=p->>'actorId' AND i.snapshot=p AND i.created_at=NEW.occurred_at AND i.xmin=original_xid) THEN RAISE EXCEPTION 'expected_laundry_original_assessment_required';END IF;
 ELSIF NEW.type='laundry.expected_invoice.cancelled' THEN
  IF NOT EXISTS(SELECT 1 FROM audit_log a WHERE a.organization_id=NEW.organization_id AND a.actor_id::text=p->>'actorId' AND a.resource_id::text=p->>'idempotencyKey' AND a.resource_type='laundry_expected_invoice_command' AND a.action=NEW.type AND a.after=p AND a.xmin=original_xid) THEN RAISE EXCEPTION 'expected_laundry_original_negative_receipt_required';END IF;
 ELSE RAISE EXCEPTION 'expected_laundry_original_receipt_type_required';END IF;RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER expected_laundry_receipt_complete AFTER INSERT ON outbox_event DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app_expected_laundry_receipt_complete();