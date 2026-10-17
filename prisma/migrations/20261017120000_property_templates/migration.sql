-- CreateTable
CREATE TABLE "property_template_version" (
    "id" UUID NOT NULL DEFAULT app_uuid_v7(),
    "organization_id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "property_id" UUID,
    "version" INTEGER NOT NULL,
    "name" JSONB NOT NULL,
    "description" JSONB,
    "values" JSONB NOT NULL,
    "status" TEXT NOT NULL,
    "created_by" UUID NOT NULL,
    "reason" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "property_template_version_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "property_template_revision" (
    "id" UUID NOT NULL DEFAULT app_uuid_v7(),
    "organization_id" UUID NOT NULL,
    "property_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "revision" INTEGER NOT NULL,
    "template_version_id" UUID NOT NULL,
    "action" TEXT NOT NULL,
    "operation_id" UUID NOT NULL,
    "command" JSONB NOT NULL,
    "snapshot" JSONB NOT NULL,
    "overrides" JSONB NOT NULL,
    "created_by" UUID NOT NULL,
    "reason" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "property_template_revision_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "property_template_version_org_scope_kind_idx" ON "property_template_version"("organization_id", "property_id", "kind", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "property_template_version_org_id_unique" ON "property_template_version"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "property_template_version_org_key_version_unique" ON "property_template_version"("organization_id", "key", "version");

-- CreateIndex
CREATE INDEX "property_template_revision_org_property_created_idx" ON "property_template_revision"("organization_id", "property_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "property_template_revision_org_operation_unique" ON "property_template_revision"("organization_id", "operation_id");

-- CreateIndex
CREATE UNIQUE INDEX "property_template_revision_org_property_kind_revision_unique" ON "property_template_revision"("organization_id", "property_id", "kind", "revision");

-- CreateIndex
CREATE UNIQUE INDEX "property_org_id_unique" ON "property"("organization_id", "id");

-- AddForeignKey
ALTER TABLE "property_template_version" ADD CONSTRAINT "property_template_version_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "property_template_version" ADD CONSTRAINT "property_template_version_organization_id_property_id_fkey" FOREIGN KEY ("organization_id", "property_id") REFERENCES "property"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "property_template_revision" ADD CONSTRAINT "property_template_revision_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "property_template_revision" ADD CONSTRAINT "property_template_revision_organization_id_property_id_fkey" FOREIGN KEY ("organization_id", "property_id") REFERENCES "property"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "property_template_revision" ADD CONSTRAINT "property_template_revision_organization_id_template_versio_fkey" FOREIGN KEY ("organization_id", "template_version_id") REFERENCES "property_template_version"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE property_template_version ADD CONSTRAINT property_template_version_shape_check CHECK (
  version > 0 AND kind IN ('PROPERTY','INVENTORY','WORKFLOW','CHECKLIST','SERVICE_CATALOG')
  AND status IN ('ACTIVE','ARCHIVED') AND jsonb_typeof(values) = 'object'
  AND jsonb_typeof(name) = 'object' AND length(name->>'en') > 0 AND length(name->>'fr') > 0
  AND length(reason) >= 6
);
ALTER TABLE property_template_revision ADD CONSTRAINT property_template_revision_shape_check CHECK (
  revision > 0 AND kind IN ('PROPERTY','INVENTORY','WORKFLOW','CHECKLIST','SERVICE_CATALOG')
  AND action IN ('APPLY','OVERRIDE','RESET') AND jsonb_typeof(command) = 'object'
  AND jsonb_typeof(snapshot) = 'object' AND jsonb_typeof(overrides) = 'object' AND length(reason) >= 6
);
ALTER TABLE property_template_version ENABLE ROW LEVEL SECURITY;
ALTER TABLE property_template_version FORCE ROW LEVEL SECURITY;
CREATE POLICY property_template_version_tenant_isolation ON property_template_version
  USING (organization_id = current_setting('app.current_organization_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.current_organization_id', true)::uuid);
ALTER TABLE property_template_revision ENABLE ROW LEVEL SECURITY;
ALTER TABLE property_template_revision FORCE ROW LEVEL SECURITY;
CREATE POLICY property_template_revision_tenant_isolation ON property_template_revision
  USING (organization_id = current_setting('app.current_organization_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.current_organization_id', true)::uuid);
CREATE FUNCTION app_protect_property_template_history() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'property template history is append-only'; END $$;
CREATE TRIGGER property_template_version_immutable BEFORE UPDATE OR DELETE ON property_template_version
  FOR EACH ROW EXECUTE FUNCTION app_protect_property_template_history();
CREATE TRIGGER property_template_revision_immutable BEFORE UPDATE OR DELETE ON property_template_revision
  FOR EACH ROW EXECUTE FUNCTION app_protect_property_template_history();
REVOKE UPDATE, DELETE ON property_template_version, property_template_revision FROM PUBLIC;
CREATE FUNCTION app_check_property_template_scope() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE previous property_template_version; selected property_template_version;
BEGIN
  IF TG_TABLE_NAME = 'property_template_version' THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('template:' || NEW.organization_id::text || ':' || NEW.key, 0));
    SELECT * INTO previous FROM property_template_version WHERE organization_id = NEW.organization_id AND key = NEW.key ORDER BY version DESC LIMIT 1;
    IF NEW.version <> coalesce(previous.version, 0) + 1 OR (previous.id IS NOT NULL AND (previous.kind <> NEW.kind OR previous.property_id IS DISTINCT FROM NEW.property_id)) THEN
      RAISE EXCEPTION 'property template version or scope mismatch';
    END IF;
  ELSE
    SELECT * INTO selected FROM property_template_version WHERE organization_id = NEW.organization_id AND id = NEW.template_version_id;
    IF selected.id IS NULL OR selected.kind <> NEW.kind OR (selected.property_id IS NOT NULL AND selected.property_id <> NEW.property_id) THEN
      RAISE EXCEPTION 'property template binding scope mismatch';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER property_template_version_consistency BEFORE INSERT ON property_template_version
  FOR EACH ROW EXECUTE FUNCTION app_check_property_template_scope();
CREATE TRIGGER property_template_revision_consistency BEFORE INSERT ON property_template_revision
  FOR EACH ROW EXECUTE FUNCTION app_check_property_template_scope();
