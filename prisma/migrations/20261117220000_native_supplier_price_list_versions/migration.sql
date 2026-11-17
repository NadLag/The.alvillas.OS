-- CreateTable
CREATE TABLE "supplier_price_list_version" (
    "id" UUID NOT NULL DEFAULT app_uuid_v7(),
    "organization_id" UUID NOT NULL,
    "supplier_id" UUID NOT NULL,
    "config_rule_id" UUID NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "supplier_price_list_version_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "supplier_price_version_supplier_idx" ON "supplier_price_list_version"("organization_id", "supplier_id", "created_at", "id");

-- CreateIndex
CREATE UNIQUE INDEX "supplier_price_version_org_id" ON "supplier_price_list_version"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "supplier_price_version_config_key" ON "supplier_price_list_version"("organization_id", "config_rule_id");

-- AddForeignKey
ALTER TABLE "supplier_price_list_version" ADD CONSTRAINT "supplier_price_list_version_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "supplier_price_list_version" ADD CONSTRAINT "supplier_price_list_version_organization_id_supplier_id_fkey" FOREIGN KEY ("organization_id", "supplier_id") REFERENCES "supplier"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "supplier_price_list_version" ADD CONSTRAINT "supplier_price_list_version_organization_id_config_rule_id_fkey" FOREIGN KEY ("organization_id", "config_rule_id") REFERENCES "config_rule"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "supplier_price_list_version" ADD CONSTRAINT "supplier_price_list_version_organization_id_created_by_fkey" FOREIGN KEY ("organization_id", "created_by") REFERENCES "user_account"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "supplier_price_list_version" ADD CONSTRAINT "supplier_price_list_version_currency_fkey" FOREIGN KEY ("currency") REFERENCES "currency"("code") ON DELETE RESTRICT ON UPDATE NO ACTION;


ALTER TABLE supplier_price_list_version ENABLE ROW LEVEL SECURITY;
ALTER TABLE supplier_price_list_version FORCE ROW LEVEL SECURITY;
CREATE POLICY supplier_price_list_version_tenant_isolation ON supplier_price_list_version USING(organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid) WITH CHECK(organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid);
CREATE TRIGGER supplier_price_version_immutable BEFORE UPDATE OR DELETE ON supplier_price_list_version FOR EACH ROW EXECUTE FUNCTION app_onboarding_append_only();

CREATE FUNCTION app_supplier_price_version_complete() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE source config_rule;source_xid xid;prices jsonb;
BEGIN
 SELECT * INTO source FROM config_rule WHERE organization_id=NEW.organization_id AND id=NEW.config_rule_id;
 SELECT xmin INTO source_xid FROM supplier_price_list_version WHERE organization_id=NEW.organization_id AND id=NEW.id;
 IF source.id IS NULL OR NEW.id<>NEW.config_rule_id OR source.key IS DISTINCT FROM 'operations.laundry_pricing.supplier.'||NEW.supplier_id::text OR source.created_by IS DISTINCT FROM NEW.created_by OR source.value->>'currency' IS DISTINCT FROM NEW.currency::text
  OR NOT EXISTS(SELECT 1 FROM config_rule c WHERE c.organization_id=NEW.organization_id AND c.id=NEW.config_rule_id AND c.xmin=source_xid)
  OR NOT EXISTS(SELECT 1 FROM supplier s WHERE s.organization_id=NEW.organization_id AND s.id=NEW.supplier_id AND(source.lifecycle='RETIRED' OR s.archived_at IS NULL))
  OR NOT EXISTS(SELECT 1 FROM audit_log a WHERE a.organization_id=NEW.organization_id AND a.actor_id=NEW.created_by AND a.resource_type='config_rule' AND a.resource_id=NEW.config_rule_id AND a.action IN('config_rule.version.created','config_rule.version.activated','config_rule.version.retired') AND a.after->>'id'=source.id::text AND a.after->>'key'=source.key AND a.after->'value'=source.value AND a.xmin=source_xid)
 THEN RAISE EXCEPTION 'supplier_price_original_configuration_proof_required';END IF;
 prices:=source.value->'prices';
 IF jsonb_typeof(source.value) IS DISTINCT FROM 'object' OR jsonb_typeof(prices) IS DISTINCT FROM 'array' OR jsonb_array_length(prices)<1 OR jsonb_array_length(prices)>500 THEN RAISE EXCEPTION 'supplier_price_original_units_required';END IF;
 IF (SELECT count(DISTINCT entry->>'item') FROM jsonb_array_elements(prices) entry)<>jsonb_array_length(prices)
  OR EXISTS(SELECT 1 FROM jsonb_array_elements(prices) entry WHERE jsonb_typeof(entry->'amount') IS DISTINCT FROM 'string' OR entry->>'amount'!~'^(0|[1-9][0-9]{0,15})[.][0-9]{2}$' OR NOT EXISTS(SELECT 1 FROM inventory_item i WHERE i.organization_id=NEW.organization_id AND i.key=entry->>'item' AND i.category='LINEN' AND i.unit=entry->>'unit' AND(source.lifecycle='RETIRED' OR i.archived_at IS NULL)))
 THEN RAISE EXCEPTION 'supplier_price_original_units_required';END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER supplier_price_version_complete AFTER INSERT ON supplier_price_list_version DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app_supplier_price_version_complete();

CREATE FUNCTION app_config_supplier_price_reference_complete() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
 IF NEW.key LIKE 'operations.laundry_pricing.supplier.%' AND NOT EXISTS(SELECT 1 FROM supplier_price_list_version p WHERE p.organization_id=NEW.organization_id AND p.config_rule_id=NEW.id) THEN RAISE EXCEPTION 'supplier_price_original_version_reference_required';END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER config_supplier_price_reference_complete AFTER INSERT ON config_rule DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app_config_supplier_price_reference_complete();
