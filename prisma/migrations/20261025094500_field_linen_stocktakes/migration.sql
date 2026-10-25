-- CreateTable
CREATE TABLE "inventory_item" (
    "id" UUID NOT NULL DEFAULT app_uuid_v7(),
    "organization_id" UUID NOT NULL,
    "key" VARCHAR(120) NOT NULL,
    "category" TEXT NOT NULL,
    "unit" VARCHAR(60),
    "labels" JSONB NOT NULL,
    "source_config_rule_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "archived_at" TIMESTAMPTZ(6),

    CONSTRAINT "inventory_item_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory_location" (
    "id" UUID NOT NULL DEFAULT app_uuid_v7(),
    "organization_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "property_id" UUID,
    "label" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "archived_at" TIMESTAMPTZ(6),

    CONSTRAINT "inventory_location_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory_stock_cursor" (
    "organization_id" UUID NOT NULL,
    "location_id" UUID NOT NULL,
    "item_id" UUID NOT NULL,
    "revision" BIGINT NOT NULL DEFAULT 0,

    CONSTRAINT "inventory_stock_cursor_pkey" PRIMARY KEY ("organization_id","location_id","item_id")
);

-- CreateTable
CREATE TABLE "inventory_stocktake" (
    "id" UUID NOT NULL DEFAULT app_uuid_v7(),
    "organization_id" UUID NOT NULL,
    "property_id" UUID,
    "task_id" UUID,
    "location_id" UUID NOT NULL,
    "item_id" UUID NOT NULL,
    "actor_id" UUID NOT NULL,
    "config_rule_id" UUID,
    "expected_revision" BIGINT NOT NULL,
    "revision" BIGINT NOT NULL,
    "expected_quantity" DECIMAL(65,0) NOT NULL,
    "counted_quantity" BIGINT NOT NULL,
    "note" TEXT NOT NULL,
    "device_id" VARCHAR(160) NOT NULL,
    "client_op_id" UUID NOT NULL,
    "client_created_at" TIMESTAMPTZ(6),
    "config_snapshot" JSONB NOT NULL,
    "received_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "inventory_stocktake_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory_movement" (
    "id" UUID NOT NULL DEFAULT app_uuid_v7(),
    "organization_id" UUID NOT NULL,
    "location_id" UUID NOT NULL,
    "item_id" UUID NOT NULL,
    "stocktake_id" UUID,
    "actor_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "revision" BIGINT NOT NULL,
    "quantity_delta" DECIMAL(65,0) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "inventory_movement_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "inventory_item_organization_id_category_archived_at_key_idx" ON "inventory_item"("organization_id", "category", "archived_at", "key");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_item_organization_id_id_key" ON "inventory_item"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_item_organization_id_key_key" ON "inventory_item"("organization_id", "key");

-- CreateIndex
CREATE INDEX "inventory_location_organization_id_kind_archived_at_id_idx" ON "inventory_location"("organization_id", "kind", "archived_at", "id");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_location_organization_id_id_key" ON "inventory_location"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_location_organization_id_property_id_key" ON "inventory_location"("organization_id", "property_id");

-- CreateIndex
CREATE INDEX "inventory_stocktake_organization_id_task_id_received_at_id_idx" ON "inventory_stocktake"("organization_id", "task_id", "received_at", "id");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_stocktake_organization_id_id_key" ON "inventory_stocktake"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_stocktake_organization_id_device_id_client_op_id_key" ON "inventory_stocktake"("organization_id", "device_id", "client_op_id");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_stocktake_organization_id_location_id_item_id_rev_key" ON "inventory_stocktake"("organization_id", "location_id", "item_id", "revision");

-- CreateIndex
CREATE INDEX "inventory_movement_organization_id_location_id_item_id_crea_idx" ON "inventory_movement"("organization_id", "location_id", "item_id", "created_at", "id");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_movement_organization_id_stocktake_id_key" ON "inventory_movement"("organization_id", "stocktake_id");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_movement_stream_revision_key" ON "inventory_movement"("organization_id", "location_id", "item_id", "revision");

-- CreateIndex
CREATE UNIQUE INDEX "config_rule_org_id_unique" ON "config_rule"("organization_id", "id");

-- AddForeignKey
ALTER TABLE "inventory_item" ADD CONSTRAINT "inventory_item_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "inventory_item" ADD CONSTRAINT "inventory_item_organization_id_source_config_rule_id_fkey" FOREIGN KEY ("organization_id", "source_config_rule_id") REFERENCES "config_rule"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "inventory_location" ADD CONSTRAINT "inventory_location_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "inventory_location" ADD CONSTRAINT "inventory_location_organization_id_property_id_fkey" FOREIGN KEY ("organization_id", "property_id") REFERENCES "property"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "inventory_stock_cursor" ADD CONSTRAINT "inventory_stock_cursor_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "inventory_stock_cursor" ADD CONSTRAINT "inventory_stock_cursor_organization_id_location_id_fkey" FOREIGN KEY ("organization_id", "location_id") REFERENCES "inventory_location"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "inventory_stock_cursor" ADD CONSTRAINT "inventory_stock_cursor_organization_id_item_id_fkey" FOREIGN KEY ("organization_id", "item_id") REFERENCES "inventory_item"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "inventory_stocktake" ADD CONSTRAINT "inventory_stocktake_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "inventory_stocktake" ADD CONSTRAINT "inventory_stocktake_organization_id_property_id_fkey" FOREIGN KEY ("organization_id", "property_id") REFERENCES "property"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "inventory_stocktake" ADD CONSTRAINT "inventory_stocktake_organization_id_task_id_fkey" FOREIGN KEY ("organization_id", "task_id") REFERENCES "operation_task"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "inventory_stocktake" ADD CONSTRAINT "inventory_stocktake_organization_id_location_id_fkey" FOREIGN KEY ("organization_id", "location_id") REFERENCES "inventory_location"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "inventory_stocktake" ADD CONSTRAINT "inventory_stocktake_organization_id_item_id_fkey" FOREIGN KEY ("organization_id", "item_id") REFERENCES "inventory_item"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "inventory_stocktake" ADD CONSTRAINT "inventory_stocktake_organization_id_actor_id_fkey" FOREIGN KEY ("organization_id", "actor_id") REFERENCES "user_account"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "inventory_stocktake" ADD CONSTRAINT "inventory_stocktake_organization_id_config_rule_id_fkey" FOREIGN KEY ("organization_id", "config_rule_id") REFERENCES "config_rule"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "inventory_movement" ADD CONSTRAINT "inventory_movement_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "inventory_movement" ADD CONSTRAINT "inventory_movement_organization_id_location_id_fkey" FOREIGN KEY ("organization_id", "location_id") REFERENCES "inventory_location"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "inventory_movement" ADD CONSTRAINT "inventory_movement_organization_id_item_id_fkey" FOREIGN KEY ("organization_id", "item_id") REFERENCES "inventory_item"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "inventory_movement" ADD CONSTRAINT "inventory_movement_organization_id_stocktake_id_fkey" FOREIGN KEY ("organization_id", "stocktake_id") REFERENCES "inventory_stocktake"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "inventory_movement" ADD CONSTRAINT "inventory_movement_organization_id_actor_id_fkey" FOREIGN KEY ("organization_id", "actor_id") REFERENCES "user_account"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;


ALTER TABLE inventory_item ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory_item FORCE ROW LEVEL SECURITY;
CREATE POLICY inventory_item_tenant_isolation ON inventory_item
 USING (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid)
 WITH CHECK (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid);

ALTER TABLE inventory_location ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory_location FORCE ROW LEVEL SECURITY;
CREATE POLICY inventory_location_tenant_isolation ON inventory_location
 USING (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid)
 WITH CHECK (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid);

ALTER TABLE inventory_stock_cursor ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory_stock_cursor FORCE ROW LEVEL SECURITY;
CREATE POLICY inventory_stock_cursor_tenant_isolation ON inventory_stock_cursor
 USING (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid)
 WITH CHECK (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid);

ALTER TABLE inventory_stocktake ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory_stocktake FORCE ROW LEVEL SECURITY;
CREATE POLICY inventory_stocktake_tenant_isolation ON inventory_stocktake
 USING (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid)
 WITH CHECK (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid);

ALTER TABLE inventory_movement ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory_movement FORCE ROW LEVEL SECURITY;
CREATE POLICY inventory_movement_tenant_isolation ON inventory_movement
 USING (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid)
 WITH CHECK (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid);

ALTER TABLE inventory_item ADD CONSTRAINT inventory_item_shape CHECK
 (key ~ '^[a-z0-9_.-]+$' AND length(key) BETWEEN 1 AND 120 AND category IN ('CONSUMABLE','LINEN','EQUIPMENT')
  AND jsonb_typeof(labels)='object' AND (unit IS NULL OR length(btrim(unit)) BETWEEN 1 AND 60));
ALTER TABLE inventory_location ADD CONSTRAINT inventory_location_shape CHECK
 (kind IN ('PROPERTY','STORE','LAUNDRY','IN_TRANSIT') AND length(btrim(label))>0
  AND ((kind='PROPERTY')=(property_id IS NOT NULL)));
ALTER TABLE inventory_stock_cursor ADD CONSTRAINT inventory_cursor_revision CHECK (revision>=0);
ALTER TABLE inventory_stocktake ADD CONSTRAINT inventory_stocktake_shape CHECK
 (counted_quantity>=0 AND expected_revision>=0 AND revision>0 AND revision-1=expected_revision
  AND length(btrim(note)) BETWEEN 1 AND 1000 AND length(device_id) BETWEEN 8 AND 160);
ALTER TABLE inventory_movement ADD CONSTRAINT inventory_movement_shape CHECK
 (kind='STOCKTAKE_ADJUSTMENT' AND stocktake_id IS NOT NULL AND quantity_delta<>0 AND revision>0);

CREATE FUNCTION app_inventory_metadata_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'inventory business rows cannot be deleted'; END IF;
 IF TG_TABLE_NAME='inventory_item' THEN
  IF ROW(NEW.id,NEW.organization_id,NEW.key,NEW.unit,NEW.source_config_rule_id,NEW.created_at)
   IS DISTINCT FROM ROW(OLD.id,OLD.organization_id,OLD.key,OLD.unit,OLD.source_config_rule_id,OLD.created_at)
  THEN RAISE EXCEPTION 'inventory item identity is immutable'; END IF;
 ELSIF TG_TABLE_NAME='inventory_location' THEN
  IF ROW(NEW.id,NEW.organization_id,NEW.kind,NEW.property_id,NEW.created_at)
   IS DISTINCT FROM ROW(OLD.id,OLD.organization_id,OLD.kind,OLD.property_id,OLD.created_at)
  THEN RAISE EXCEPTION 'inventory location identity is immutable'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER inventory_item_guard BEFORE UPDATE OR DELETE ON inventory_item
 FOR EACH ROW EXECUTE FUNCTION app_inventory_metadata_guard();
CREATE TRIGGER inventory_location_guard BEFORE UPDATE OR DELETE ON inventory_location
 FOR EACH ROW EXECUTE FUNCTION app_inventory_metadata_guard();

CREATE FUNCTION app_inventory_cursor_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'inventory cursor cannot be deleted'; END IF;
 IF TG_OP='INSERT' THEN
  IF NEW.revision<>0 THEN RAISE EXCEPTION 'inventory cursor begins at zero'; END IF;
 ELSE
  IF ROW(NEW.organization_id,NEW.location_id,NEW.item_id) IS DISTINCT FROM
   ROW(OLD.organization_id,OLD.location_id,OLD.item_id) OR NEW.revision-1<>OLD.revision
  THEN RAISE EXCEPTION 'inventory cursor advances one immutable stream'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER inventory_cursor_guard BEFORE INSERT OR UPDATE OR DELETE ON inventory_stock_cursor
 FOR EACH ROW EXECUTE FUNCTION app_inventory_cursor_guard();

CREATE FUNCTION app_inventory_stocktake_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE position_revision bigint; position_quantity numeric;
BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'inventory stocktakes are append only'; END IF;
 SELECT revision INTO position_revision FROM inventory_stock_cursor
  WHERE organization_id=NEW.organization_id AND location_id=NEW.location_id AND item_id=NEW.item_id FOR UPDATE;
 IF NOT FOUND OR position_revision<>NEW.expected_revision THEN RAISE EXCEPTION 'inventory stocktake revision conflict'; END IF;
 SELECT COALESCE(sum(quantity_delta),0) INTO position_quantity FROM inventory_movement
  WHERE organization_id=NEW.organization_id AND location_id=NEW.location_id AND item_id=NEW.item_id;
 IF position_quantity<>NEW.expected_quantity THEN RAISE EXCEPTION 'inventory stocktake quantity conflict'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER inventory_stocktake_guard BEFORE INSERT OR UPDATE OR DELETE ON inventory_stocktake
 FOR EACH ROW EXECUTE FUNCTION app_inventory_stocktake_guard();

CREATE FUNCTION app_inventory_movement_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE observation inventory_stocktake;
BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'inventory movements are append only'; END IF;
 SELECT * INTO observation FROM inventory_stocktake WHERE organization_id=NEW.organization_id AND id=NEW.stocktake_id;
 IF NOT FOUND OR ROW(NEW.location_id,NEW.item_id,NEW.actor_id,NEW.revision)
   IS DISTINCT FROM ROW(observation.location_id,observation.item_id,observation.actor_id,observation.revision)
   OR NEW.quantity_delta<>observation.counted_quantity-observation.expected_quantity
 THEN RAISE EXCEPTION 'inventory movement must match its immutable observation'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER inventory_movement_guard BEFORE INSERT OR UPDATE OR DELETE ON inventory_movement
 FOR EACH ROW EXECUTE FUNCTION app_inventory_movement_guard();

CREATE FUNCTION app_inventory_stocktake_complete() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE movement_count integer; movement_delta numeric; current_revision bigint;
BEGIN
 SELECT revision INTO current_revision FROM inventory_stock_cursor
  WHERE organization_id=NEW.organization_id AND location_id=NEW.location_id AND item_id=NEW.item_id;
 SELECT count(*)::integer,COALESCE(sum(quantity_delta),0) INTO movement_count,movement_delta
  FROM inventory_movement WHERE organization_id=NEW.organization_id AND stocktake_id=NEW.id;
 IF current_revision IS NULL OR current_revision<NEW.revision OR
  movement_delta<>NEW.counted_quantity-NEW.expected_quantity OR
  movement_count<>(CASE WHEN NEW.counted_quantity=NEW.expected_quantity THEN 0 ELSE 1 END)
 THEN RAISE EXCEPTION 'inventory observation and derived movement must commit together'; END IF;
 IF NOT EXISTS (SELECT 1 FROM audit_log WHERE organization_id=NEW.organization_id AND resource_id=NEW.id
  AND actor_id=NEW.actor_id AND action='inventory.stocktake.record')
 THEN RAISE EXCEPTION 'inventory stocktake audit is required'; END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER inventory_stocktake_complete AFTER INSERT ON inventory_stocktake
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app_inventory_stocktake_complete();

CREATE FUNCTION app_inventory_cursor_complete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS (SELECT 1 FROM inventory_stocktake WHERE organization_id=NEW.organization_id
  AND location_id=NEW.location_id AND item_id=NEW.item_id AND revision=NEW.revision)
 THEN RAISE EXCEPTION 'inventory revision requires an immutable observation'; END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER inventory_cursor_complete AFTER UPDATE ON inventory_stock_cursor
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app_inventory_cursor_complete();
