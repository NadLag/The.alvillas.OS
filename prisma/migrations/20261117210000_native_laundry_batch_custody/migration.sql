-- CreateTable
CREATE TABLE "laundry_batch" (
    "id" UUID NOT NULL DEFAULT app_uuid_v7(),
    "organization_id" UUID NOT NULL,
    "source_location_id" UUID NOT NULL,
    "outbound_transit_id" UUID NOT NULL,
    "laundry_location_id" UUID NOT NULL,
    "inbound_transit_id" UUID NOT NULL,
    "return_location_id" UUID NOT NULL,
    "supplier_id" UUID,
    "reservation_id" UUID,
    "idempotency_key" UUID NOT NULL,
    "request_hash" CHAR(64) NOT NULL,
    "review_fingerprint" CHAR(64) NOT NULL,
    "snapshot" JSONB NOT NULL,
    "reason" VARCHAR(500) NOT NULL,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "laundry_batch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "laundry_batch_line" (
    "id" UUID NOT NULL DEFAULT app_uuid_v7(),
    "organization_id" UUID NOT NULL,
    "batch_id" UUID NOT NULL,
    "item_id" UUID NOT NULL,
    "condition" VARCHAR(16) NOT NULL,
    "quantity" DECIMAL(65,0) NOT NULL,

    CONSTRAINT "laundry_batch_line_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "laundry_batch_event" (
    "id" UUID NOT NULL DEFAULT app_uuid_v7(),
    "organization_id" UUID NOT NULL,
    "batch_id" UUID NOT NULL,
    "sequence" INTEGER NOT NULL,
    "operation" VARCHAR(32) NOT NULL,
    "idempotency_key" UUID NOT NULL,
    "request_hash" CHAR(64) NOT NULL,
    "review_fingerprint" CHAR(64) NOT NULL,
    "reverses_event_id" UUID,
    "command" JSONB NOT NULL,
    "snapshot" JSONB NOT NULL,
    "reason" VARCHAR(500) NOT NULL,
    "created_by" UUID NOT NULL,
    "observed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "laundry_batch_event_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "laundry_batch_change" (
    "id" UUID NOT NULL DEFAULT app_uuid_v7(),
    "organization_id" UUID NOT NULL,
    "event_id" UUID NOT NULL,
    "line_id" UUID NOT NULL,
    "from_bucket" VARCHAR(40) NOT NULL,
    "to_bucket" VARCHAR(40) NOT NULL,
    "quantity" DECIMAL(65,0) NOT NULL,
    "reverses_change_id" UUID,
    "movement_group_id" UUID,
    "movement_receipt" JSONB,

    CONSTRAINT "laundry_batch_change_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "laundry_batch_history_idx" ON "laundry_batch"("organization_id", "created_at" DESC, "id" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "laundry_batch_org_id_key" ON "laundry_batch"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "laundry_batch_nonce_key" ON "laundry_batch"("organization_id", "idempotency_key");

-- CreateIndex
CREATE UNIQUE INDEX "laundry_line_org_id_key" ON "laundry_batch_line"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "laundry_line_source_key" ON "laundry_batch_line"("organization_id", "batch_id", "item_id", "condition");

-- CreateIndex
CREATE INDEX "laundry_event_history_idx" ON "laundry_batch_event"("organization_id", "batch_id", "created_at" DESC, "id" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "laundry_event_org_id_key" ON "laundry_batch_event"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "laundry_event_nonce_key" ON "laundry_batch_event"("organization_id", "idempotency_key");

-- CreateIndex
CREATE UNIQUE INDEX "laundry_event_sequence_key" ON "laundry_batch_event"("organization_id", "batch_id", "sequence");

-- CreateIndex
CREATE UNIQUE INDEX "laundry_event_reversal_key" ON "laundry_batch_event"("organization_id", "reverses_event_id");

-- CreateIndex
CREATE INDEX "laundry_change_history_idx" ON "laundry_batch_change"("organization_id", "line_id", "event_id");

-- CreateIndex
CREATE UNIQUE INDEX "laundry_change_org_id_key" ON "laundry_batch_change"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "laundry_change_event_line_key" ON "laundry_batch_change"("organization_id", "event_id", "line_id");

-- CreateIndex
CREATE UNIQUE INDEX "laundry_change_reversal_key" ON "laundry_batch_change"("organization_id", "reverses_change_id");

-- AddForeignKey
ALTER TABLE "laundry_batch" ADD CONSTRAINT "laundry_batch_org_fk" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "laundry_batch" ADD CONSTRAINT "laundry_batch_origin_fk" FOREIGN KEY ("organization_id", "source_location_id") REFERENCES "inventory_location"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "laundry_batch" ADD CONSTRAINT "laundry_batch_outbound_fk" FOREIGN KEY ("organization_id", "outbound_transit_id") REFERENCES "inventory_location"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "laundry_batch" ADD CONSTRAINT "laundry_batch_processor_fk" FOREIGN KEY ("organization_id", "laundry_location_id") REFERENCES "inventory_location"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "laundry_batch" ADD CONSTRAINT "laundry_batch_inbound_fk" FOREIGN KEY ("organization_id", "inbound_transit_id") REFERENCES "inventory_location"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "laundry_batch" ADD CONSTRAINT "laundry_batch_returned_fk" FOREIGN KEY ("organization_id", "return_location_id") REFERENCES "inventory_location"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "laundry_batch" ADD CONSTRAINT "laundry_batch_supplier_fk" FOREIGN KEY ("organization_id", "supplier_id") REFERENCES "supplier"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "laundry_batch" ADD CONSTRAINT "laundry_batch_reservation_fk" FOREIGN KEY ("organization_id", "reservation_id") REFERENCES "reservation"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "laundry_batch" ADD CONSTRAINT "laundry_batch_creator_fk" FOREIGN KEY ("organization_id", "created_by") REFERENCES "user_account"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "laundry_batch_line" ADD CONSTRAINT "laundry_line_org_fk" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "laundry_batch_line" ADD CONSTRAINT "laundry_line_batch_fk" FOREIGN KEY ("organization_id", "batch_id") REFERENCES "laundry_batch"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "laundry_batch_line" ADD CONSTRAINT "laundry_line_item_fk" FOREIGN KEY ("organization_id", "item_id") REFERENCES "inventory_item"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "laundry_batch_event" ADD CONSTRAINT "laundry_event_org_fk" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "laundry_batch_event" ADD CONSTRAINT "laundry_event_batch_fk" FOREIGN KEY ("organization_id", "batch_id") REFERENCES "laundry_batch"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "laundry_batch_event" ADD CONSTRAINT "laundry_event_creator_fk" FOREIGN KEY ("organization_id", "created_by") REFERENCES "user_account"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "laundry_batch_event" ADD CONSTRAINT "laundry_event_reverses_fk" FOREIGN KEY ("organization_id", "reverses_event_id") REFERENCES "laundry_batch_event"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "laundry_batch_change" ADD CONSTRAINT "laundry_change_org_fk" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "laundry_batch_change" ADD CONSTRAINT "laundry_change_event_fk" FOREIGN KEY ("organization_id", "event_id") REFERENCES "laundry_batch_event"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "laundry_batch_change" ADD CONSTRAINT "laundry_change_line_fk" FOREIGN KEY ("organization_id", "line_id") REFERENCES "laundry_batch_line"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "laundry_batch_change" ADD CONSTRAINT "laundry_change_reverses_fk" FOREIGN KEY ("organization_id", "reverses_change_id") REFERENCES "laundry_batch_change"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;


-- Business custody is append-only. Original inventory movements remain the
-- only physical stock ledger; no financial or legacy business rows are changed.
ALTER TABLE laundry_batch ADD CONSTRAINT laundry_batch_hash_shape CHECK(request_hash~'^[a-f0-9]{64}$' AND review_fingerprint~'^[a-f0-9]{64}$' AND length(trim(reason))>=6);
ALTER TABLE laundry_batch_line ADD CONSTRAINT laundry_line_quantity_shape CHECK(quantity>0 AND quantity<1e40 AND condition IN('USABLE','DAMAGED'));
ALTER TABLE laundry_batch_event ADD CONSTRAINT laundry_event_shape CHECK(sequence>0 AND request_hash~'^[a-f0-9]{64}$' AND review_fingerprint~'^[a-f0-9]{64}$' AND length(trim(reason))>=6 AND operation IN('SEND','RECEIVE_LAUNDRY','WASH_COMPLETE','REJECT','REWASH','DAMAGE','DISPATCH_RETURN','RECEIVE_RETURN','MARK_MISSING','FIND_MISSING','CONFIRM_LOSS','REVERSE','CLOSE','CANCEL') AND (operation='REVERSE')=(reverses_event_id IS NOT NULL));
ALTER TABLE laundry_batch_change ADD CONSTRAINT laundry_change_shape CHECK(quantity>0 AND quantity<1e40 AND from_bucket<>to_bucket AND (movement_group_id IS NULL)=(movement_receipt IS NULL));
CREATE UNIQUE INDEX laundry_change_movement_key ON laundry_batch_change(organization_id,movement_group_id);

CREATE FUNCTION app_laundry_bucket_location(b laundry_batch,bucket text) RETURNS uuid LANGUAGE sql IMMUTABLE SET search_path=public,pg_temp AS $$
 SELECT CASE WHEN bucket='ORIGIN' THEN b.source_location_id
  WHEN regexp_replace(bucket,'^MISSING_','') LIKE 'OUTBOUND%' THEN b.outbound_transit_id
  WHEN regexp_replace(bucket,'^MISSING_','') LIKE 'INBOUND%' THEN b.inbound_transit_id
  WHEN bucket LIKE 'RETURNED%' THEN b.return_location_id
  WHEN regexp_replace(bucket,'^MISSING_','') IN('LAUNDRY_PENDING','CLEAN_READY','REJECTED','DAMAGED_READY') THEN b.laundry_location_id END
$$;
CREATE FUNCTION app_laundry_bucket_damaged(bucket text) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
 SELECT regexp_replace(bucket,'^MISSING_','') IN('OUTBOUND_DAMAGED','DAMAGED_READY','INBOUND_DAMAGED','RETURNED_DAMAGED')
$$;
CREATE FUNCTION app_laundry_transition_target(operation text,source text,initial_condition text) RETURNS text LANGUAGE sql IMMUTABLE AS $$
 SELECT CASE
  WHEN operation='SEND' AND source='ORIGIN' THEN CASE WHEN initial_condition='DAMAGED' THEN 'OUTBOUND_DAMAGED' ELSE 'OUTBOUND' END
  WHEN operation='RECEIVE_LAUNDRY' AND source IN('OUTBOUND','OUTBOUND_DAMAGED') THEN CASE WHEN source='OUTBOUND_DAMAGED' THEN 'DAMAGED_READY' ELSE 'LAUNDRY_PENDING' END
  WHEN operation='WASH_COMPLETE' AND source='LAUNDRY_PENDING' THEN 'CLEAN_READY'
  WHEN operation='REJECT' AND source='LAUNDRY_PENDING' THEN 'REJECTED'
  WHEN operation='REWASH' AND source='REJECTED' THEN 'LAUNDRY_PENDING'
  WHEN operation='DAMAGE' AND source IN('OUTBOUND','LAUNDRY_PENDING','CLEAN_READY','REJECTED','INBOUND_CLEAN') THEN CASE WHEN source='OUTBOUND' THEN 'OUTBOUND_DAMAGED' WHEN source='INBOUND_CLEAN' THEN 'INBOUND_DAMAGED' ELSE 'DAMAGED_READY' END
  WHEN operation='DISPATCH_RETURN' AND source IN('CLEAN_READY','DAMAGED_READY') THEN CASE WHEN source='DAMAGED_READY' THEN 'INBOUND_DAMAGED' ELSE 'INBOUND_CLEAN' END
  WHEN operation='RECEIVE_RETURN' AND source IN('INBOUND_CLEAN','INBOUND_DAMAGED') THEN CASE WHEN source='INBOUND_DAMAGED' THEN 'RETURNED_DAMAGED' ELSE 'RETURNED_CLEAN' END
  WHEN operation='MARK_MISSING' AND source IN('OUTBOUND','OUTBOUND_DAMAGED','LAUNDRY_PENDING','CLEAN_READY','REJECTED','DAMAGED_READY','INBOUND_CLEAN','INBOUND_DAMAGED') THEN 'MISSING_'||source
  WHEN operation='FIND_MISSING' AND source IN('MISSING_OUTBOUND','MISSING_OUTBOUND_DAMAGED','MISSING_LAUNDRY_PENDING','MISSING_CLEAN_READY','MISSING_REJECTED','MISSING_DAMAGED_READY','MISSING_INBOUND_CLEAN','MISSING_INBOUND_DAMAGED') THEN substr(source,9)
  WHEN operation='CONFIRM_LOSS' AND source IN('MISSING_OUTBOUND','MISSING_OUTBOUND_DAMAGED','MISSING_LAUNDRY_PENDING','MISSING_CLEAN_READY','MISSING_REJECTED','MISSING_DAMAGED_READY','MISSING_INBOUND_CLEAN','MISSING_INBOUND_DAMAGED') THEN CASE WHEN source LIKE 'MISSING_OUTBOUND%' THEN 'LOST_OUTBOUND' WHEN source LIKE 'MISSING_INBOUND%' THEN 'LOST_INBOUND' ELSE 'LOST_LAUNDRY' END
 END
$$;
CREATE FUNCTION app_laundry_line_position(tenant uuid,line_id uuid,bucket text,before_sequence integer) RETURNS numeric LANGUAGE sql STABLE SET search_path=public,pg_temp AS $$
 SELECT CASE WHEN bucket='ORIGIN' THEN l.quantity ELSE 0 END+COALESCE((SELECT sum(CASE WHEN c.to_bucket=bucket THEN c.quantity ELSE 0 END-CASE WHEN c.from_bucket=bucket THEN c.quantity ELSE 0 END) FROM laundry_batch_change c JOIN laundry_batch_event e ON e.organization_id=c.organization_id AND e.id=c.event_id WHERE c.organization_id=tenant AND c.line_id=l.id AND e.sequence<before_sequence),0)
 FROM laundry_batch_line l WHERE l.organization_id=tenant AND l.id=line_id
$$;

CREATE FUNCTION app_laundry_header_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM inventory_location a,inventory_location o,inventory_location w,inventory_location i,inventory_location r WHERE a.organization_id=NEW.organization_id AND o.organization_id=a.organization_id AND w.organization_id=a.organization_id AND i.organization_id=a.organization_id AND r.organization_id=a.organization_id AND a.id=NEW.source_location_id AND o.id=NEW.outbound_transit_id AND w.id=NEW.laundry_location_id AND i.id=NEW.inbound_transit_id AND r.id=NEW.return_location_id AND a.kind IN('PROPERTY','STORE','IN_TRANSIT') AND o.kind='IN_TRANSIT' AND w.kind='LAUNDRY' AND i.kind='IN_TRANSIT' AND r.kind IN('PROPERTY','STORE') AND a.archived_at IS NULL AND o.archived_at IS NULL AND w.archived_at IS NULL AND i.archived_at IS NULL AND r.archived_at IS NULL)
  OR NEW.source_location_id IN(NEW.outbound_transit_id,NEW.laundry_location_id,NEW.inbound_transit_id) OR NEW.return_location_id IN(NEW.outbound_transit_id,NEW.laundry_location_id,NEW.inbound_transit_id)
  OR NEW.laundry_location_id IN(NEW.outbound_transit_id,NEW.inbound_transit_id)
 THEN RAISE EXCEPTION 'laundry_original_custody_locations_required';END IF;
 IF NEW.supplier_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM supplier s WHERE s.organization_id=NEW.organization_id AND s.id=NEW.supplier_id AND s.archived_at IS NULL) THEN RAISE EXCEPTION 'laundry_original_supplier_required';END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER laundry_header_guard BEFORE INSERT ON laundry_batch FOR EACH ROW EXECUTE FUNCTION app_laundry_header_guard();

CREATE FUNCTION app_laundry_header_complete() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE receipt outbox_event; source_xid xid; p jsonb; draft jsonb; n integer;
BEGIN
 SELECT xmin INTO source_xid FROM laundry_batch WHERE organization_id=NEW.organization_id AND id=NEW.id;
 SELECT * INTO receipt FROM outbox_event WHERE organization_id=NEW.organization_id AND type='laundry.batch.created' AND idempotency_key='laundry-batch-create:'||NEW.idempotency_key::text;
 p:=receipt.payload;draft:=p->'draft';SELECT count(*) INTO n FROM laundry_batch_line WHERE organization_id=NEW.organization_id AND batch_id=NEW.id;
 IF receipt.id IS NULL OR p IS DISTINCT FROM NEW.snapshot OR p->>'schemaVersion' IS DISTINCT FROM '1' OR p->>'organizationId' IS DISTINCT FROM NEW.organization_id::text OR p->>'actorId' IS DISTINCT FROM NEW.created_by::text OR p->>'batchId' IS DISTINCT FROM NEW.id::text OR p->>'idempotencyKey' IS DISTINCT FROM NEW.idempotency_key::text OR p->>'requestHash' IS DISTINCT FROM NEW.request_hash OR p->>'reviewFingerprint' IS DISTINCT FROM NEW.review_fingerprint
  OR draft->>'sourceLocationId' IS DISTINCT FROM NEW.source_location_id::text OR draft->>'outboundTransitId' IS DISTINCT FROM NEW.outbound_transit_id::text OR draft->>'laundryLocationId' IS DISTINCT FROM NEW.laundry_location_id::text OR draft->>'inboundTransitId' IS DISTINCT FROM NEW.inbound_transit_id::text OR draft->>'returnLocationId' IS DISTINCT FROM NEW.return_location_id::text OR draft->>'supplierId' IS DISTINCT FROM NEW.supplier_id::text OR draft->>'reservationId' IS DISTINCT FROM NEW.reservation_id::text OR draft->>'reason' IS DISTINCT FROM NEW.reason OR jsonb_typeof(p->'lines') IS DISTINCT FROM 'array' OR jsonb_typeof(draft->'lines') IS DISTINCT FROM 'array' OR n<1 OR n>50 OR n<>jsonb_array_length(p->'lines') OR n<>jsonb_array_length(draft->'lines') OR receipt.occurred_at<>NEW.created_at
  OR EXISTS(SELECT 1 FROM laundry_batch_line l WHERE l.organization_id=NEW.organization_id AND l.batch_id=NEW.id AND(l.xmin<>source_xid OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(p->'lines') entry WHERE entry->>'id'=l.id::text AND entry->>'itemId'=l.item_id::text AND entry->>'condition'=l.condition AND entry->>'quantity'=l.quantity::text)))
  OR EXISTS(SELECT 1 FROM laundry_batch_line l WHERE l.organization_id=NEW.organization_id AND l.batch_id=NEW.id AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(draft->'lines') entry WHERE entry->>'itemId'=l.item_id::text AND entry->>'condition'=l.condition AND entry->>'quantity'=l.quantity::text))
  OR NOT EXISTS(SELECT 1 FROM outbox_event e WHERE e.organization_id=NEW.organization_id AND e.id=receipt.id AND e.xmin=source_xid)
  OR NOT EXISTS(SELECT 1 FROM audit_log a WHERE a.organization_id=NEW.organization_id AND a.actor_id=NEW.created_by AND a.resource_type='laundry_batch' AND a.resource_id=NEW.id AND a.action='laundry.batch.created' AND a.after->>'batchId'=NEW.id::text AND a.xmin=source_xid)
 THEN RAISE EXCEPTION 'laundry_original_header_receipt_required';END IF;RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER laundry_header_complete AFTER INSERT ON laundry_batch DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app_laundry_header_complete();

CREATE FUNCTION app_laundry_line_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE source_xid xid;
BEGIN
 SELECT xmin INTO source_xid FROM laundry_batch WHERE organization_id=NEW.organization_id AND id=NEW.batch_id;
 IF source_xid IS NULL OR NOT EXISTS(SELECT 1 FROM laundry_batch b CROSS JOIN LATERAL jsonb_array_elements(b.snapshot->'lines') entry WHERE b.organization_id=NEW.organization_id AND b.id=NEW.batch_id AND entry->>'id'=NEW.id::text AND entry->>'itemId'=NEW.item_id::text AND entry->>'condition'=NEW.condition AND entry->>'quantity'=NEW.quantity::text) OR NOT EXISTS(SELECT 1 FROM inventory_item i WHERE i.organization_id=NEW.organization_id AND i.id=NEW.item_id AND i.category='LINEN' AND i.unit IS NOT NULL AND i.archived_at IS NULL) THEN RAISE EXCEPTION 'laundry_original_linen_item_required';END IF;RETURN NEW;
END $$;
CREATE TRIGGER laundry_line_guard BEFORE INSERT ON laundry_batch_line FOR EACH ROW EXECUTE FUNCTION app_laundry_line_guard();

CREATE FUNCTION app_laundry_event_complete() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE source_xid xid;receipt outbox_event;original laundry_batch_event;p jsonb;n integer;max_sequence integer;
BEGIN
 SELECT xmin INTO source_xid FROM laundry_batch_event WHERE organization_id=NEW.organization_id AND id=NEW.id;
 SELECT * INTO receipt FROM outbox_event WHERE organization_id=NEW.organization_id AND type='laundry.batch.recorded' AND idempotency_key='laundry-batch-event:'||NEW.idempotency_key::text;p:=receipt.payload;
 SELECT count(*),max(sequence) INTO n,max_sequence FROM laundry_batch_event WHERE organization_id=NEW.organization_id AND batch_id=NEW.batch_id;
 IF n<>max_sequence OR jsonb_typeof(p->'changes') IS DISTINCT FROM 'array' OR NEW.command->>'batchId' IS DISTINCT FROM NEW.batch_id::text OR NEW.command->>'operation' IS DISTINCT FROM NEW.operation OR NEW.command->>'expectedSequence' IS DISTINCT FROM (NEW.sequence-1)::text OR NEW.command->>'reason' IS DISTINCT FROM NEW.reason OR NEW.command->>'reversesEventId' IS DISTINCT FROM NEW.reverses_event_id::text OR receipt.id IS NULL OR p IS DISTINCT FROM NEW.snapshot OR p->>'schemaVersion' IS DISTINCT FROM '1' OR p->>'organizationId' IS DISTINCT FROM NEW.organization_id::text OR p->>'actorId' IS DISTINCT FROM NEW.created_by::text OR p->>'batchId' IS DISTINCT FROM NEW.batch_id::text OR p->>'eventId' IS DISTINCT FROM NEW.id::text OR p->>'sequence' IS DISTINCT FROM NEW.sequence::text OR p->>'operation' IS DISTINCT FROM NEW.operation OR p->>'idempotencyKey' IS DISTINCT FROM NEW.idempotency_key::text OR p->>'requestHash' IS DISTINCT FROM NEW.request_hash OR p->>'reviewFingerprint' IS DISTINCT FROM NEW.review_fingerprint OR p->'draft' IS DISTINCT FROM NEW.command
  OR NOT EXISTS(SELECT 1 FROM outbox_event e WHERE e.organization_id=NEW.organization_id AND e.id=receipt.id AND e.xmin=source_xid)
  OR NOT EXISTS(SELECT 1 FROM audit_log a WHERE a.organization_id=NEW.organization_id AND a.actor_id=NEW.created_by AND a.resource_type='laundry_batch_event' AND a.resource_id=NEW.id AND a.action='laundry.batch.recorded' AND a.after->>'batchId'=NEW.batch_id::text AND a.xmin=source_xid)
 THEN RAISE EXCEPTION 'laundry_original_event_receipt_required';END IF;
 IF EXISTS(SELECT 1 FROM laundry_batch_event closed WHERE closed.organization_id=NEW.organization_id AND closed.batch_id=NEW.batch_id AND closed.sequence<NEW.sequence AND closed.operation IN('CLOSE','CANCEL') AND NOT EXISTS(SELECT 1 FROM laundry_batch_event r WHERE r.organization_id=closed.organization_id AND r.reverses_event_id=closed.id AND r.sequence<NEW.sequence)) AND NEW.operation<>'REVERSE' THEN RAISE EXCEPTION 'laundry_closed_batch_requires_original_reversal';END IF;
 SELECT count(*) INTO n FROM laundry_batch_change WHERE organization_id=NEW.organization_id AND event_id=NEW.id;
 IF n<>jsonb_array_length(p->'changes') OR NEW.operation IN('CLOSE','CANCEL') AND n<>0 OR NEW.operation NOT IN('CLOSE','CANCEL','REVERSE') AND(n<1 OR n>50) THEN RAISE EXCEPTION 'laundry_original_event_changes_required';END IF;
 IF NEW.operation='REVERSE' THEN SELECT * INTO original FROM laundry_batch_event WHERE organization_id=NEW.organization_id AND id=NEW.reverses_event_id;IF original.id IS NULL OR original.batch_id<>NEW.batch_id OR original.sequence>=NEW.sequence OR original.operation='REVERSE' OR n<>(SELECT count(*) FROM laundry_batch_change WHERE organization_id=NEW.organization_id AND event_id=original.id) THEN RAISE EXCEPTION 'laundry_original_event_reversal_required';END IF;END IF;
 IF NEW.operation IN('CLOSE','CANCEL') AND EXISTS(SELECT 1 FROM laundry_batch_line l CROSS JOIN LATERAL(SELECT 'ORIGIN' AS bucket,l.quantity AS quantity UNION ALL SELECT c.from_bucket,-c.quantity FROM laundry_batch_change c JOIN laundry_batch_event e ON e.organization_id=c.organization_id AND e.id=c.event_id WHERE c.organization_id=l.organization_id AND c.line_id=l.id AND e.sequence<NEW.sequence UNION ALL SELECT c.to_bucket,c.quantity FROM laundry_batch_change c JOIN laundry_batch_event e ON e.organization_id=c.organization_id AND e.id=c.event_id WHERE c.organization_id=l.organization_id AND c.line_id=l.id AND e.sequence<NEW.sequence)position WHERE l.organization_id=NEW.organization_id AND l.batch_id=NEW.batch_id GROUP BY l.id,position.bucket HAVING sum(position.quantity)<>0 AND(NEW.operation='CLOSE' AND position.bucket NOT IN('RETURNED_CLEAN','RETURNED_DAMAGED','LOST_OUTBOUND','LOST_LAUNDRY','LOST_INBOUND') OR NEW.operation='CANCEL' AND position.bucket<>'ORIGIN')) THEN RAISE EXCEPTION 'laundry_original_custody_still_outstanding';END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER laundry_event_complete AFTER INSERT ON laundry_batch_event DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app_laundry_event_complete();

CREATE FUNCTION app_laundry_change_complete() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE event laundry_batch_event;batch laundry_batch;line laundry_batch_line;original laundry_batch_change;expected text;native_kind text;native_condition text;native_source uuid;native_target uuid;request jsonb;source_xid xid;
BEGIN
 SELECT * INTO event FROM laundry_batch_event WHERE organization_id=NEW.organization_id AND id=NEW.event_id;SELECT * INTO batch FROM laundry_batch WHERE organization_id=NEW.organization_id AND id=event.batch_id;SELECT * INTO line FROM laundry_batch_line WHERE organization_id=NEW.organization_id AND id=NEW.line_id;
 SELECT xmin INTO source_xid FROM laundry_batch_event WHERE organization_id=NEW.organization_id AND id=event.id;
 IF event.id IS NULL OR line.id IS NULL OR line.batch_id<>batch.id OR app_laundry_line_position(NEW.organization_id,line.id,NEW.from_bucket,event.sequence)<NEW.quantity
  OR NOT EXISTS(SELECT 1 FROM laundry_batch_change c WHERE c.organization_id=NEW.organization_id AND c.id=NEW.id AND c.xmin=source_xid)
  OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(event.snapshot->'changes') entry WHERE entry->>'id'=NEW.id::text AND entry->>'lineId'=NEW.line_id::text AND entry->>'from'=NEW.from_bucket AND entry->>'to'=NEW.to_bucket AND entry->>'quantity'=NEW.quantity::text AND entry->>'movementGroupId' IS NOT DISTINCT FROM NEW.movement_group_id::text AND NULLIF(entry->'movementReceipt','null'::jsonb) IS NOT DISTINCT FROM NEW.movement_receipt)
 THEN RAISE EXCEPTION 'laundry_original_line_change_required';END IF;
 IF event.operation='REVERSE' THEN
  SELECT * INTO original FROM laundry_batch_change WHERE organization_id=NEW.organization_id AND id=NEW.reverses_change_id;
  IF original.id IS NULL OR original.event_id<>event.reverses_event_id OR original.line_id<>NEW.line_id OR original.from_bucket<>NEW.to_bucket OR original.to_bucket<>NEW.from_bucket OR original.quantity<>NEW.quantity THEN RAISE EXCEPTION 'laundry_original_change_reversal_required';END IF;
  native_kind:=CASE WHEN original.movement_group_id IS NULL THEN NULL ELSE 'REVERSAL' END;
 ELSE
  expected:=app_laundry_transition_target(event.operation,NEW.from_bucket,line.condition);IF expected IS NULL OR expected<>NEW.to_bucket OR NEW.reverses_change_id IS NOT NULL THEN RAISE EXCEPTION 'laundry_original_disposition_required';END IF;
  native_kind:=CASE WHEN event.operation IN('SEND','RECEIVE_LAUNDRY') THEN 'LAUNDRY_SEND' WHEN event.operation IN('DISPATCH_RETURN','RECEIVE_RETURN') THEN 'LAUNDRY_RETURN' WHEN event.operation='DAMAGE' THEN 'DAMAGE' WHEN event.operation='CONFIRM_LOSS' THEN 'LOSS' END;
  native_source:=app_laundry_bucket_location(batch,NEW.from_bucket);native_target:=app_laundry_bucket_location(batch,NEW.to_bucket);native_condition:=CASE WHEN event.operation='SEND' THEN line.condition WHEN app_laundry_bucket_damaged(NEW.from_bucket) THEN 'DAMAGED' ELSE 'USABLE' END;
 END IF;
 IF (native_kind IS NULL)<>(NEW.movement_group_id IS NULL) THEN RAISE EXCEPTION 'laundry_native_movement_effect_required';END IF;
 IF native_kind IS NOT NULL THEN
  IF NOT EXISTS(SELECT 1 FROM outbox_event e WHERE e.organization_id=NEW.organization_id AND e.type='inventory.movement.recorded' AND e.idempotency_key='inventory-movement:'||NEW.movement_group_id::text AND e.payload=NEW.movement_receipt AND e.payload->>'actorId'=event.created_by::text AND e.xmin=source_xid) THEN RAISE EXCEPTION 'laundry_original_native_receipt_required';END IF;
  SELECT source_snapshot->'request' INTO request FROM inventory_movement WHERE organization_id=NEW.organization_id AND movement_group_id=NEW.movement_group_id AND leg=1;
  IF request->>'kind' IS DISTINCT FROM native_kind OR native_kind='REVERSAL' AND request->>'originalGroupId' IS DISTINCT FROM original.movement_group_id::text
   OR native_kind<>'REVERSAL' AND(request->>'itemId' IS DISTINCT FROM line.item_id::text OR request->>'locationId' IS DISTINCT FROM native_source::text OR request->>'quantity' IS DISTINCT FROM NEW.quantity::text OR native_kind IN('LAUNDRY_SEND','LAUNDRY_RETURN') AND(request->>'destinationLocationId' IS DISTINCT FROM native_target::text OR request->>'condition' IS DISTINCT FROM native_condition) OR native_kind='LOSS' AND request->>'condition' IS DISTINCT FROM native_condition)
  THEN RAISE EXCEPTION 'laundry_original_native_movement_source_required';END IF;
 END IF;RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER laundry_change_complete AFTER INSERT ON laundry_batch_change DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app_laundry_change_complete();

ALTER TABLE laundry_batch ENABLE ROW LEVEL SECURITY;
ALTER TABLE laundry_batch FORCE ROW LEVEL SECURITY;
CREATE POLICY laundry_batch_tenant ON laundry_batch USING(organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid) WITH CHECK(organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid);
CREATE TRIGGER laundry_batch_immutable BEFORE UPDATE OR DELETE ON laundry_batch FOR EACH ROW EXECUTE FUNCTION app_onboarding_append_only();

ALTER TABLE laundry_batch_line ENABLE ROW LEVEL SECURITY;
ALTER TABLE laundry_batch_line FORCE ROW LEVEL SECURITY;
CREATE POLICY laundry_batch_line_tenant ON laundry_batch_line USING(organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid) WITH CHECK(organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid);
CREATE TRIGGER laundry_batch_line_immutable BEFORE UPDATE OR DELETE ON laundry_batch_line FOR EACH ROW EXECUTE FUNCTION app_onboarding_append_only();

ALTER TABLE laundry_batch_event ENABLE ROW LEVEL SECURITY;
ALTER TABLE laundry_batch_event FORCE ROW LEVEL SECURITY;
CREATE POLICY laundry_batch_event_tenant ON laundry_batch_event USING(organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid) WITH CHECK(organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid);
CREATE TRIGGER laundry_batch_event_immutable BEFORE UPDATE OR DELETE ON laundry_batch_event FOR EACH ROW EXECUTE FUNCTION app_onboarding_append_only();

ALTER TABLE laundry_batch_change ENABLE ROW LEVEL SECURITY;
ALTER TABLE laundry_batch_change FORCE ROW LEVEL SECURITY;
CREATE POLICY laundry_batch_change_tenant ON laundry_batch_change USING(organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid) WITH CHECK(organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid);
CREATE TRIGGER laundry_batch_change_immutable BEFORE UPDATE OR DELETE ON laundry_batch_change FOR EACH ROW EXECUTE FUNCTION app_onboarding_append_only();

CREATE FUNCTION app_laundry_receipt_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
 IF TG_OP='UPDATE' OR TG_OP='DELETE' THEN
  IF OLD.idempotency_key LIKE 'laundry-batch-create:%' OR OLD.idempotency_key LIKE 'laundry-batch-event:%' THEN
   IF TG_OP='DELETE' THEN RAISE EXCEPTION 'laundry_original_receipt_immutable';END IF;
   IF NEW.id<>OLD.id OR NEW.organization_id<>OLD.organization_id OR NEW.type<>OLD.type OR NEW.idempotency_key<>OLD.idempotency_key OR NEW.payload IS DISTINCT FROM OLD.payload OR NEW.occurred_at<>OLD.occurred_at THEN RAISE EXCEPTION 'laundry_original_receipt_immutable';END IF;RETURN NEW;
  END IF;
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD;END IF;
 IF NEW.idempotency_key NOT LIKE 'laundry-batch-create:%' AND NEW.idempotency_key NOT LIKE 'laundry-batch-event:%' AND NEW.type NOT IN('laundry.batch.created','laundry.batch.recorded','laundry.batch.command_cancelled') THEN RETURN NEW;END IF;
 IF NEW.payload->>'schemaVersion' IS DISTINCT FROM '1' OR NEW.payload->>'organizationId' IS DISTINCT FROM NEW.organization_id::text OR NEW.payload->>'idempotencyKey' IS NULL OR NEW.payload->>'actorId' IS NULL THEN RAISE EXCEPTION 'laundry_original_receipt_shape_required';END IF;
 IF NEW.type='laundry.batch.created' THEN
  IF NEW.idempotency_key IS DISTINCT FROM 'laundry-batch-create:'||(NEW.payload->>'idempotencyKey') OR NOT EXISTS(SELECT 1 FROM laundry_batch b WHERE b.organization_id=NEW.organization_id AND b.id::text=NEW.payload->>'batchId' AND b.snapshot=NEW.payload AND b.created_by::text=NEW.payload->>'actorId') THEN RAISE EXCEPTION 'laundry_original_batch_receipt_required';END IF;
 ELSIF NEW.type='laundry.batch.recorded' THEN
  IF NEW.idempotency_key IS DISTINCT FROM 'laundry-batch-event:'||(NEW.payload->>'idempotencyKey') OR NOT EXISTS(SELECT 1 FROM laundry_batch_event e WHERE e.organization_id=NEW.organization_id AND e.id::text=NEW.payload->>'eventId' AND e.snapshot=NEW.payload AND e.created_by::text=NEW.payload->>'actorId') THEN RAISE EXCEPTION 'laundry_original_event_receipt_required';END IF;
 ELSIF NEW.type='laundry.batch.command_cancelled' THEN
  IF COALESCE(NEW.payload->>'purpose','') NOT IN('CREATE','EVENT') OR NEW.idempotency_key IS DISTINCT FROM ((CASE NEW.payload->>'purpose' WHEN 'CREATE' THEN 'laundry-batch-create:' ELSE 'laundry-batch-event:' END)||(NEW.payload->>'idempotencyKey')) OR NOT EXISTS(SELECT 1 FROM audit_log a WHERE a.organization_id=NEW.organization_id AND a.actor_id::text=NEW.payload->>'actorId' AND a.resource_type='laundry_batch_command' AND a.resource_id::text=NEW.payload->>'idempotencyKey' AND a.action=NEW.type AND a.after=NEW.payload) THEN RAISE EXCEPTION 'laundry_original_negative_receipt_required';END IF;
 ELSE RAISE EXCEPTION 'laundry_original_receipt_type_required';END IF;RETURN NEW;
END $$;
CREATE TRIGGER laundry_receipt_guard BEFORE INSERT OR UPDATE OR DELETE ON outbox_event FOR EACH ROW EXECUTE FUNCTION app_laundry_receipt_guard();

CREATE FUNCTION app_laundry_cancelled_complete() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE original_xid xid;
BEGIN
 IF NEW.type<>'laundry.batch.command_cancelled' THEN RETURN NULL;END IF;
 SELECT xmin INTO original_xid FROM outbox_event WHERE organization_id=NEW.organization_id AND id=NEW.id;
 IF NOT EXISTS(SELECT 1 FROM audit_log a WHERE a.organization_id=NEW.organization_id AND a.action=NEW.type AND a.resource_type='laundry_batch_command' AND a.resource_id::text=NEW.payload->>'idempotencyKey' AND a.actor_id::text=NEW.payload->>'actorId' AND a.after=NEW.payload AND a.xmin=original_xid) THEN RAISE EXCEPTION 'laundry_original_cancellation_audit_required';END IF;RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER laundry_cancelled_complete AFTER INSERT ON outbox_event DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app_laundry_cancelled_complete();
