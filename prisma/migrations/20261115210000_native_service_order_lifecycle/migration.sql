-- CreateTable
CREATE TABLE "service_order" (
    "id" UUID NOT NULL DEFAULT app_uuid_v7(),
    "organization_id" UUID NOT NULL,
    "property_id" UUID NOT NULL,
    "reservation_id" UUID NOT NULL,
    "catalog_rule_id" UUID NOT NULL,
    "catalog_rule_version" INTEGER NOT NULL,
    "service_key" TEXT NOT NULL,
    "title_translations" JSONB NOT NULL,
    "service_date" DATE NOT NULL,
    "last_service_date" DATE NOT NULL,
    "quantity" BIGINT NOT NULL,
    "guest_count" INTEGER NOT NULL,
    "request_snapshot" JSONB NOT NULL,
    "catalog_snapshot" JSONB NOT NULL,
    "source_witnesses" JSONB NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'REQUESTED',
    "version" INTEGER NOT NULL DEFAULT 1,
    "total_amount" DECIMAL(18,2),
    "currency" CHAR(3) NOT NULL,
    "quote_reference" TEXT,
    "task_id" UUID,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "service_order_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "service_order_event" (
    "id" UUID NOT NULL DEFAULT app_uuid_v7(),
    "organization_id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "from_state" TEXT,
    "to_state" TEXT NOT NULL,
    "snapshot" JSONB NOT NULL,
    "command_key" UUID NOT NULL,
    "command_hash" TEXT NOT NULL,
    "review_fingerprint" TEXT NOT NULL,
    "created_by" UUID NOT NULL,
    "reason" TEXT NOT NULL,
    "request_id" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "service_order_event_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "service_order_property_page_idx" ON "service_order"("organization_id", "property_id", "id");
CREATE INDEX "service_order_property_date_idx" ON "service_order"("organization_id", "property_id", "service_date", "id");

-- CreateIndex
CREATE INDEX "service_order_reservation_page_idx" ON "service_order"("organization_id", "reservation_id", "id");

-- CreateIndex
CREATE INDEX "service_order_state_page_idx" ON "service_order"("organization_id", "state", "id");

-- CreateIndex
CREATE UNIQUE INDEX "service_order_org_id_key" ON "service_order"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "service_order_native_task_key" ON "service_order"("organization_id", "task_id");

-- CreateIndex

-- CreateIndex
CREATE UNIQUE INDEX "service_order_event_org_id_key" ON "service_order_event"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "service_order_event_version_key" ON "service_order_event"("organization_id", "order_id", "version");

-- CreateIndex
CREATE UNIQUE INDEX "service_order_event_command_key" ON "service_order_event"("organization_id", "command_key");

-- AddForeignKey
ALTER TABLE "service_order" ADD CONSTRAINT "service_order_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "service_order" ADD CONSTRAINT "service_order_organization_id_property_id_fkey" FOREIGN KEY ("organization_id", "property_id") REFERENCES "property"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "service_order" ADD CONSTRAINT "service_order_organization_id_reservation_id_fkey" FOREIGN KEY ("organization_id", "reservation_id") REFERENCES "reservation"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "service_order" ADD CONSTRAINT "service_order_organization_id_catalog_rule_id_fkey" FOREIGN KEY ("organization_id", "catalog_rule_id") REFERENCES "config_rule"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "service_order" ADD CONSTRAINT "service_order_currency_fkey" FOREIGN KEY ("currency") REFERENCES "currency"("code") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "service_order" ADD CONSTRAINT "service_order_organization_id_task_id_fkey" FOREIGN KEY ("organization_id", "task_id") REFERENCES "operation_task"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "service_order" ADD CONSTRAINT "service_order_organization_id_created_by_fkey" FOREIGN KEY ("organization_id", "created_by") REFERENCES "user_account"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "service_order_event" ADD CONSTRAINT "service_order_event_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "service_order_event" ADD CONSTRAINT "service_order_event_organization_id_order_id_fkey" FOREIGN KEY ("organization_id", "order_id") REFERENCES "service_order"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "service_order_event" ADD CONSTRAINT "service_order_event_organization_id_created_by_fkey" FOREIGN KEY ("organization_id", "created_by") REFERENCES "user_account"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

ALTER TABLE service_order ADD CONSTRAINT service_order_state_check CHECK(state IN('REQUESTED','QUOTED','CONFIRMED','IN_PROGRESS','FULFILLED','REJECTED','CANCELLED')),
 ADD CONSTRAINT service_order_version_check CHECK(version>0 AND catalog_rule_version>0),
 ADD CONSTRAINT service_order_amount_check CHECK(total_amount IS NULL OR total_amount>=0),
 ADD CONSTRAINT service_order_dimensions_check CHECK(quantity BETWEEN 1 AND 9007199254740991 AND guest_count>0 AND isfinite(service_date) AND isfinite(last_service_date) AND last_service_date>=service_date),
 ADD CONSTRAINT service_order_originals_check CHECK(jsonb_typeof(request_snapshot)='object' AND jsonb_typeof(catalog_snapshot)='object' AND jsonb_typeof(source_witnesses)='object');
ALTER TABLE service_order_event ADD CONSTRAINT service_order_event_version_check CHECK(version>0),
 ADD CONSTRAINT service_order_event_hash_check CHECK(command_hash ~ '^[a-f0-9]{64}$' AND review_fingerprint ~ '^[a-f0-9]{64}$'),
 ADD CONSTRAINT service_order_event_reason_check CHECK(length(btrim(reason)) BETWEEN 6 AND 500),
 ADD CONSTRAINT service_order_event_snapshot_check CHECK(jsonb_typeof(snapshot)='object');

ALTER TABLE service_order ENABLE ROW LEVEL SECURITY;
ALTER TABLE service_order FORCE ROW LEVEL SECURITY;
CREATE POLICY service_order_tenant ON service_order
 USING(organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid)
 WITH CHECK(organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid);
ALTER TABLE service_order_event ENABLE ROW LEVEL SECURITY;
ALTER TABLE service_order_event FORCE ROW LEVEL SECURITY;
CREATE POLICY service_order_event_tenant ON service_order_event
 USING(organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid)
 WITH CHECK(organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid);
CREATE TRIGGER service_order_event_immutable BEFORE UPDATE OR DELETE ON service_order_event
 FOR EACH ROW EXECUTE FUNCTION app_onboarding_append_only();

CREATE FUNCTION app_guard_service_order() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE source config_rule%ROWTYPE;policy config_rule%ROWTYPE;entry jsonb;money_precision integer;expected_total numeric;
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'service_order_history_immutable'; END IF;
 IF TG_OP='INSERT' THEN
  IF NEW.version<>1 OR NEW.state<>'REQUESTED' OR NEW.quote_reference IS NOT NULL OR NEW.task_id IS NOT NULL
   OR NEW.created_at<>NEW.updated_at OR NEW.created_at<transaction_timestamp() OR NEW.created_at>clock_timestamp()
   OR NOT EXISTS(SELECT 1 FROM reservation r JOIN property p ON p.organization_id=r.organization_id AND p.id=r.property_id
    JOIN user_account u ON u.organization_id=r.organization_id AND u.id=NEW.created_by
    WHERE r.organization_id=NEW.organization_id AND r.id=NEW.reservation_id AND r.property_id=NEW.property_id
     AND r.archived_at IS NULL AND p.archived_at IS NULL AND u.status='ACTIVE' AND r.status NOT IN('CANCELLED','NO_SHOW','CLOSED')
     AND NEW.service_date>=r.check_in AND NEW.last_service_date<=r.check_out AND NEW.guest_count<=r.adult_count+r.child_count)
   OR NEW.request_snapshot->>'propertyId' IS DISTINCT FROM NEW.property_id::text
   OR NEW.request_snapshot->>'reservationId' IS DISTINCT FROM NEW.reservation_id::text
   OR NEW.request_snapshot->>'serviceKey' IS DISTINCT FROM NEW.service_key
   OR NEW.request_snapshot->>'serviceDate' IS DISTINCT FROM NEW.service_date::text
   OR NEW.request_snapshot->>'lastServiceDate' IS DISTINCT FROM NEW.last_service_date::text
   OR NEW.request_snapshot->>'quantity' IS DISTINCT FROM NEW.quantity::text
   OR NEW.request_snapshot->>'guests' IS DISTINCT FROM NEW.guest_count::text
  THEN RAISE EXCEPTION 'service_order_native_request_required'; END IF;
  SELECT * INTO source FROM config_rule WHERE organization_id=NEW.organization_id AND id=NEW.catalog_rule_id;
  SELECT item INTO entry FROM jsonb_array_elements(source.value->'services') item WHERE item->>'key'=NEW.service_key;
  IF source.key IS DISTINCT FROM 'services.pricing' OR source.version IS DISTINCT FROM NEW.catalog_rule_version
   OR source.archived_at IS NOT NULL OR source.created_by IS NULL OR source.lifecycle NOT IN('ACTIVE','RETIRED')
   OR source.effective_from>NEW.created_at OR source.effective_to<=NEW.created_at
   OR entry IS NULL OR entry->>'available' IS DISTINCT FROM 'true' OR jsonb_typeof(entry->'order_terms') IS DISTINCT FROM 'object'
   OR NEW.catalog_snapshot IS DISTINCT FROM(SELECT jsonb_object_agg(k,v) FROM jsonb_each(entry) fields(k,v)
     WHERE k IN('key','name','description','available','pricing_model','amount','currency','order_terms'))
   OR NEW.currency IS DISTINCT FROM entry->>'currency'
   OR NEW.title_translations IS DISTINCT FROM entry->'name'
   OR (entry->>'pricing_model'='CUSTOM') IS DISTINCT FROM (NEW.total_amount IS NULL)
  THEN RAISE EXCEPTION 'service_order_original_catalog_required'; END IF;
  SELECT * INTO policy FROM config_rule WHERE organization_id=NEW.organization_id AND id=(NEW.source_witnesses#>>'{policyRule,id}')::uuid;
  IF NOT coalesce(policy.key='services.ordering' AND policy.version=(NEW.source_witnesses#>>'{policyRule,version}')::integer
   AND policy.archived_at IS NULL AND policy.created_by IS NOT NULL AND policy.lifecycle IN('ACTIVE','RETIRED')
   AND policy.effective_from<=NEW.created_at AND(policy.effective_to IS NULL OR policy.effective_to>NEW.created_at)
   AND policy.value->>'schemaVersion'='1' AND policy.value->>'participant_basis'='SELECTED_RESERVATION_GUESTS'
   AND policy.value->>'date_basis'='INCLUSIVE_RESERVATION_DATES'
   AND NEW.quantity<=(policy.value->>'max_quantity')::bigint
   AND NEW.last_service_date-NEW.service_date+1<=(policy.value->>'max_service_days')::bigint,false)
  THEN RAISE EXCEPTION 'service_order_configured_request_limits_required'; END IF;
  IF entry->>'pricing_model'<>'CUSTOM' THEN
   expected_total=(entry->>'amount')::numeric*NEW.quantity*CASE entry->>'pricing_model'
    WHEN 'PER_GUEST' THEN NEW.guest_count WHEN 'PER_DAY' THEN NEW.last_service_date-NEW.service_date+1 ELSE 1 END;
   IF NEW.total_amount IS DISTINCT FROM expected_total THEN RAISE EXCEPTION 'service_order_exact_catalog_total_required'; END IF;
  END IF;
 ELSE
  IF ROW(OLD.id,OLD.organization_id,OLD.property_id,OLD.reservation_id,OLD.catalog_rule_id,OLD.catalog_rule_version,
    OLD.service_key,OLD.title_translations,OLD.service_date,OLD.last_service_date,OLD.quantity,OLD.guest_count,
    OLD.request_snapshot,OLD.catalog_snapshot,OLD.source_witnesses,OLD.currency,OLD.created_by,OLD.created_at)
   IS DISTINCT FROM ROW(NEW.id,NEW.organization_id,NEW.property_id,NEW.reservation_id,NEW.catalog_rule_id,NEW.catalog_rule_version,
    NEW.service_key,NEW.title_translations,NEW.service_date,NEW.last_service_date,NEW.quantity,NEW.guest_count,
    NEW.request_snapshot,NEW.catalog_snapshot,NEW.source_witnesses,NEW.currency,NEW.created_by,NEW.created_at)
   OR NEW.version<>OLD.version+1 OR NEW.updated_at<OLD.updated_at OR NEW.updated_at>clock_timestamp()
   OR NOT((OLD.state='REQUESTED' AND NEW.state IN('QUOTED','CONFIRMED','REJECTED','CANCELLED'))
    OR(OLD.state='QUOTED' AND NEW.state IN('QUOTED','CONFIRMED','REJECTED','CANCELLED'))
    OR(OLD.state='CONFIRMED' AND NEW.state IN('IN_PROGRESS','CANCELLED'))
    OR(OLD.state='IN_PROGRESS' AND NEW.state IN('FULFILLED','CANCELLED')))
  THEN RAISE EXCEPTION 'service_order_original_or_transition_immutable'; END IF;
  IF NEW.state='QUOTED' THEN
   IF NEW.catalog_snapshot->>'pricing_model'<>'CUSTOM' OR NEW.total_amount IS NULL OR NEW.quote_reference IS NULL OR length(btrim(NEW.quote_reference)) NOT BETWEEN 1 AND 240
   THEN RAISE EXCEPTION 'service_order_explicit_quote_required'; END IF;
  ELSIF ROW(OLD.total_amount,OLD.quote_reference) IS DISTINCT FROM ROW(NEW.total_amount,NEW.quote_reference)
   THEN RAISE EXCEPTION 'service_order_original_price_immutable';
  END IF;
  IF OLD.task_id IS DISTINCT FROM NEW.task_id AND (OLD.task_id IS NOT NULL OR NEW.state<>'CONFIRMED' OR NOT EXISTS(
   SELECT 1 FROM operation_task t WHERE t.organization_id=NEW.organization_id AND t.id=NEW.task_id
    AND t.property_id=NEW.property_id AND t.reservation_id=NEW.reservation_id AND t.archived_at IS NULL
    AND t.xmin::text=pg_current_xact_id()::xid::text))
  THEN RAISE EXCEPTION 'service_order_native_task_required'; END IF;
  IF NEW.state IN('CONFIRMED','IN_PROGRESS','FULFILLED') AND NEW.total_amount IS NULL
  THEN RAISE EXCEPTION 'service_order_accepted_total_required'; END IF;
 END IF;
 SELECT minor_unit INTO money_precision FROM currency WHERE code=NEW.currency;
 IF money_precision IS NULL OR money_precision NOT BETWEEN 0 AND 2 OR NEW.total_amount<>round(NEW.total_amount,money_precision)
 THEN RAISE EXCEPTION 'service_order_registered_currency_required'; END IF;
 IF NEW.task_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM operation_task t WHERE t.organization_id=NEW.organization_id
  AND t.id=NEW.task_id AND t.property_id=NEW.property_id AND t.reservation_id=NEW.reservation_id)
 THEN RAISE EXCEPTION 'service_order_task_scope_mismatch'; END IF;
 IF NEW.state IN('IN_PROGRESS','FULFILLED') AND NOT EXISTS(SELECT 1 FROM operation_task t
  WHERE t.organization_id=NEW.organization_id AND t.id=NEW.task_id AND t.archived_at IS NULL
   AND t.state=CASE WHEN NEW.state='IN_PROGRESS' THEN 'IN_PROGRESS' ELSE 'COMPLETED' END
   AND EXISTS(SELECT 1 FROM operation_task_event e WHERE e.organization_id=t.organization_id AND e.task_id=t.id
    AND e.kind='CHANGED' AND e.version<=t.version AND e.after->>'state'=t.state AND e.before->>'state' IS DISTINCT FROM t.state)
   AND(NEW.state<>'FULFILLED' OR(t.completed_at IS NOT NULL AND t.completed_by_person_id IS NOT NULL AND t.completion_idempotency_key IS NOT NULL)))
 THEN RAISE EXCEPTION 'service_order_actual_work_required'; END IF;
 IF NEW.state='CANCELLED' AND EXISTS(SELECT 1 FROM operation_task t WHERE t.organization_id=NEW.organization_id AND t.id=NEW.task_id AND t.state='COMPLETED')
 THEN RAISE EXCEPTION 'service_order_completed_work_cannot_be_cancelled'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER service_order_original_guard BEFORE INSERT OR UPDATE OR DELETE ON service_order
 FOR EACH ROW EXECUTE FUNCTION app_guard_service_order();

CREATE FUNCTION app_service_order_receipt(e service_order_event) RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
 SELECT jsonb_build_object('schemaVersion',1,'actorId',e.created_by,'orderId',e.order_id,'eventId',e.id,
  'version',e.version,'state',e.to_state,'commandKey',e.command_key,'commandHash',e.command_hash,'reviewFingerprint',e.review_fingerprint)
$$;
CREATE FUNCTION app_service_order_event_complete() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE root service_order%ROWTYPE;receipt jsonb;previous_state text;
BEGIN
 SELECT * INTO root FROM service_order WHERE organization_id=NEW.organization_id AND id=NEW.order_id;
 SELECT to_state INTO previous_state FROM service_order_event WHERE organization_id=NEW.organization_id AND order_id=NEW.order_id AND version=NEW.version-1;
 receipt=app_service_order_receipt(NEW);
 IF root.id IS NULL OR root.version<>NEW.version OR root.state<>NEW.to_state OR NEW.from_state IS DISTINCT FROM previous_state
  OR(NEW.version=1 AND(NEW.from_state IS NOT NULL OR NEW.to_state<>'REQUESTED' OR root.created_by<>NEW.created_by OR root.created_at<>NEW.created_at))
  OR(NEW.version>1 AND previous_state IS NULL) OR NEW.created_at<>root.updated_at
  OR NEW.snapshot IS DISTINCT FROM jsonb_build_object('state',root.state,'totalAmount',CASE WHEN root.total_amount IS NULL THEN NULL ELSE root.total_amount::text END,
    'currency',root.currency,'quoteReference',root.quote_reference,'taskId',root.task_id)
  OR NOT EXISTS(SELECT 1 FROM service_order r WHERE r.organization_id=NEW.organization_id AND r.id=NEW.order_id AND r.xmin::text=pg_current_xact_id()::xid::text)
  OR NOT EXISTS(SELECT 1 FROM service_order_event e WHERE e.organization_id=NEW.organization_id AND e.id=NEW.id AND e.xmin::text=pg_current_xact_id()::xid::text)
  OR NOT EXISTS(SELECT 1 FROM user_account u WHERE u.organization_id=NEW.organization_id AND u.id=NEW.created_by AND u.status='ACTIVE')
  OR NOT EXISTS(SELECT 1 FROM audit_log a WHERE a.organization_id=NEW.organization_id AND a.actor_id=NEW.created_by
   AND a.resource_type='service_order' AND a.resource_id=NEW.order_id AND a.property_scope_id=root.property_id
   AND a.action='service.order.changed' AND a.after=receipt AND a.reason IS NULL AND a.request_id=NEW.request_id
   AND a.occurred_at=NEW.created_at AND a.xmin::text=pg_current_xact_id()::xid::text)
  OR NOT EXISTS(SELECT 1 FROM outbox_event o WHERE o.organization_id=NEW.organization_id AND o.type='service.order.changed'
   AND o.idempotency_key='service-order:'||NEW.command_key::text AND o.payload=receipt AND o.occurred_at=NEW.created_at
   AND o.xmin::text=pg_current_xact_id()::xid::text)
 THEN RAISE EXCEPTION 'service_order_atomic_original_history_required'; END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER service_order_event_birth_guard AFTER INSERT ON service_order_event
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app_service_order_event_complete();
CREATE FUNCTION app_service_order_history_complete() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM service_order_event e WHERE e.organization_id=NEW.organization_id AND e.order_id=NEW.id
  AND e.version=NEW.version AND e.to_state=NEW.state AND e.xmin::text=pg_current_xact_id()::xid::text)
 THEN RAISE EXCEPTION 'service_order_native_history_required'; END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER service_order_history_guard AFTER INSERT OR UPDATE ON service_order
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app_service_order_history_complete();

CREATE FUNCTION app_guard_service_order_outbox() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
 IF TG_OP='DELETE' THEN
  IF OLD.type='service.order.changed' THEN RAISE EXCEPTION 'service_order_receipt_immutable'; END IF;
  RETURN OLD;
 END IF;
 IF TG_OP='UPDATE' THEN
  IF(OLD.type='service.order.changed' OR NEW.type='service.order.changed') AND
   ROW(OLD.id,OLD.organization_id,OLD.type,OLD.payload,OLD.idempotency_key,OLD.occurred_at,OLD.created_at)
    IS DISTINCT FROM ROW(NEW.id,NEW.organization_id,NEW.type,NEW.payload,NEW.idempotency_key,NEW.occurred_at,NEW.created_at)
  THEN RAISE EXCEPTION 'service_order_receipt_immutable'; END IF;
  RETURN NEW;
 END IF;
 IF NEW.type='service.order.changed' AND NOT EXISTS(SELECT 1 FROM service_order_event e
  WHERE e.organization_id=NEW.organization_id AND NEW.payload=app_service_order_receipt(e)
   AND NEW.idempotency_key='service-order:'||e.command_key::text AND NEW.occurred_at=e.created_at
   AND e.xmin::text=pg_current_xact_id()::xid::text AND NEW.status='PENDING' AND NEW.attempt_count=0
   AND NEW.processed_at IS NULL AND NEW.next_attempt_at IS NULL AND NEW.last_error IS NULL)
 THEN RAISE EXCEPTION 'service_order_original_receipt_required'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER service_order_outbox_guard BEFORE INSERT OR UPDATE OR DELETE ON outbox_event
 FOR EACH ROW EXECUTE FUNCTION app_guard_service_order_outbox();

