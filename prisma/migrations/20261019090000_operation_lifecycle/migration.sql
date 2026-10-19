-- AlterTable
ALTER TABLE "operation_task" ADD COLUMN     "checklist_config_rule_id" UUID,
ADD COLUMN     "checklist_template_key" TEXT,
ADD COLUMN     "completion_source" TEXT,
ADD COLUMN     "validated_at" TIMESTAMPTZ(6),
ADD COLUMN     "validated_by_person_id" UUID,
ADD COLUMN     "validated_by_user_account_id" UUID,
ADD COLUMN     "validation_reason" TEXT,
ADD COLUMN     "version" INTEGER NOT NULL DEFAULT 1;

-- CreateTable
CREATE TABLE "operation_task_event" (
    "id" UUID NOT NULL DEFAULT app_uuid_v7(),
    "organization_id" UUID NOT NULL,
    "task_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "kind" TEXT NOT NULL,
    "actor_id" UUID,
    "request_id" TEXT,
    "reason" TEXT,
    "before" JSONB,
    "after" JSONB NOT NULL,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "operation_task_event_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "operation_task_mutation" (
    "id" UUID NOT NULL DEFAULT app_uuid_v7(),
    "organization_id" UUID NOT NULL,
    "task_id" UUID NOT NULL,
    "key" UUID NOT NULL,
    "payload_hash" TEXT NOT NULL,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "operation_task_mutation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "operation_task_event_history_idx" ON "operation_task_event"("organization_id", "task_id", "occurred_at");

-- CreateIndex
CREATE UNIQUE INDEX "operation_task_event_version_unique" ON "operation_task_event"("organization_id", "task_id", "version");

-- CreateIndex
CREATE INDEX "operation_task_mutation_task_idx" ON "operation_task_mutation"("organization_id", "task_id");

ALTER TABLE operation_task_event ADD CONSTRAINT operation_task_event_org_fk FOREIGN KEY (organization_id) REFERENCES organization(id) ON DELETE RESTRICT;
ALTER TABLE operation_task_mutation ADD CONSTRAINT operation_task_mutation_org_fk FOREIGN KEY (organization_id) REFERENCES organization(id) ON DELETE RESTRICT;
CREATE UNIQUE INDEX operation_task_org_id_unique ON operation_task(organization_id, id);
ALTER TABLE operation_task_event ADD CONSTRAINT operation_task_event_task_fk FOREIGN KEY (organization_id, task_id) REFERENCES operation_task(organization_id, id) ON DELETE RESTRICT;
ALTER TABLE operation_task_mutation ADD CONSTRAINT operation_task_mutation_task_fk FOREIGN KEY (organization_id, task_id) REFERENCES operation_task(organization_id, id) ON DELETE RESTRICT;
ALTER TABLE operation_task_event ENABLE ROW LEVEL SECURITY;
ALTER TABLE operation_task_event FORCE ROW LEVEL SECURITY;
CREATE POLICY operation_task_event_tenant_isolation ON operation_task_event USING (organization_id = current_setting('app.current_organization_id', true)::uuid) WITH CHECK (organization_id = current_setting('app.current_organization_id', true)::uuid);
ALTER TABLE operation_task_mutation ENABLE ROW LEVEL SECURITY;
ALTER TABLE operation_task_mutation FORCE ROW LEVEL SECURITY;
CREATE POLICY operation_task_mutation_tenant_isolation ON operation_task_mutation USING (organization_id = current_setting('app.current_organization_id', true)::uuid) WITH CHECK (organization_id = current_setting('app.current_organization_id', true)::uuid);

CREATE FUNCTION app_operation_task_version() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.version := OLD.version + 1;
  RETURN NEW;
END $$;
CREATE TRIGGER operation_task_version BEFORE UPDATE ON operation_task FOR EACH ROW EXECUTE FUNCTION app_operation_task_version();
CREATE FUNCTION app_operation_task_history() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO operation_task_event(organization_id, task_id, version, kind, actor_id, request_id, reason, before, after)
  VALUES (NEW.organization_id, NEW.id, NEW.version, CASE WHEN TG_OP = 'INSERT' THEN 'CREATED' ELSE 'CHANGED' END,
    nullif(current_setting('app.task_actor_id', true), '')::uuid,
    nullif(current_setting('app.task_request_id', true), ''), nullif(current_setting('app.task_reason', true), ''),
    CASE WHEN TG_OP = 'UPDATE' THEN to_jsonb(OLD) ELSE NULL END, to_jsonb(NEW));
  RETURN NEW;
END $$;
-- Snapshot existing records without changing existing task or financial values.
INSERT INTO operation_task_event(organization_id, task_id, version, kind, actor_id, reason, after)
SELECT organization_id, id, version, 'SNAPSHOT', NULL, 'Existing task at lifecycle migration', to_jsonb(t) FROM operation_task t;
CREATE TRIGGER operation_task_history AFTER INSERT OR UPDATE ON operation_task FOR EACH ROW EXECUTE FUNCTION app_operation_task_history();
CREATE FUNCTION app_operation_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Operational history is append-only'; END $$;
CREATE TRIGGER operation_task_event_immutable BEFORE UPDATE OR DELETE ON operation_task_event FOR EACH ROW EXECUTE FUNCTION app_operation_immutable();
CREATE TRIGGER operation_task_mutation_immutable BEFORE UPDATE OR DELETE ON operation_task_mutation FOR EACH ROW EXECUTE FUNCTION app_operation_immutable();
CREATE TRIGGER operation_task_no_delete BEFORE DELETE ON operation_task FOR EACH ROW EXECUTE FUNCTION app_operation_immutable();

-- CreateIndex
CREATE UNIQUE INDEX "operation_task_mutation_key_unique" ON "operation_task_mutation"("organization_id", "key");
