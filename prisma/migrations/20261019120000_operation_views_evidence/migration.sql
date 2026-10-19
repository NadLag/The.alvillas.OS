-- CreateTable
CREATE TABLE "operation_saved_view" (
    "id" UUID NOT NULL DEFAULT app_uuid_v7(),
    "organization_id" UUID NOT NULL,
    "user_account_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "filters" JSONB NOT NULL,
    "archived_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "operation_saved_view_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "operation_task_evidence" (
    "id" UUID NOT NULL DEFAULT app_uuid_v7(),
    "organization_id" UUID NOT NULL,
    "task_id" UUID NOT NULL,
    "note" TEXT NOT NULL,
    "storage_key" TEXT,
    "content_type" TEXT,
    "size" INTEGER,
    "sha256" TEXT,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "operation_task_evidence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "operation_issue" (
    "id" UUID NOT NULL DEFAULT app_uuid_v7(),
    "organization_id" UUID NOT NULL,
    "task_id" UUID NOT NULL,
    "property_id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'OPEN',
    "idempotency_key" UUID NOT NULL,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "operation_issue_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "operation_saved_view_user_idx" ON "operation_saved_view"("organization_id", "user_account_id", "archived_at");

-- CreateIndex
CREATE UNIQUE INDEX "operation_saved_view_name_unique" ON "operation_saved_view"("organization_id", "user_account_id", "name");

-- CreateIndex
CREATE UNIQUE INDEX "operation_task_evidence_storage_key_key" ON "operation_task_evidence"("storage_key");

-- CreateIndex
CREATE INDEX "operation_evidence_task_idx" ON "operation_task_evidence"("organization_id", "task_id", "created_at");

-- CreateIndex
CREATE INDEX "operation_issue_property_state_idx" ON "operation_issue"("organization_id", "property_id", "state");

-- CreateIndex
CREATE UNIQUE INDEX "operation_issue_key_unique" ON "operation_issue"("organization_id", "idempotency_key");

-- AddForeignKey
ALTER TABLE "operation_saved_view" ADD CONSTRAINT "operation_saved_view_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "operation_saved_view" ADD CONSTRAINT "operation_saved_view_organization_id_user_account_id_fkey" FOREIGN KEY ("organization_id", "user_account_id") REFERENCES "user_account"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "operation_task_evidence" ADD CONSTRAINT "operation_task_evidence_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "operation_task_evidence" ADD CONSTRAINT "operation_task_evidence_organization_id_task_id_fkey" FOREIGN KEY ("organization_id", "task_id") REFERENCES "operation_task"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "operation_issue" ADD CONSTRAINT "operation_issue_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "operation_issue" ADD CONSTRAINT "operation_issue_organization_id_task_id_fkey" FOREIGN KEY ("organization_id", "task_id") REFERENCES "operation_task"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;


ALTER TABLE operation_saved_view ENABLE ROW LEVEL SECURITY;
ALTER TABLE operation_saved_view FORCE ROW LEVEL SECURITY;
CREATE POLICY operation_saved_view_tenant_isolation ON operation_saved_view USING (organization_id = current_setting('app.current_organization_id',true)::uuid) WITH CHECK (organization_id = current_setting('app.current_organization_id',true)::uuid);
CREATE TRIGGER operation_saved_view_no_delete BEFORE DELETE ON operation_saved_view FOR EACH ROW EXECUTE FUNCTION app_operation_immutable();

ALTER TABLE operation_task_evidence ENABLE ROW LEVEL SECURITY;
ALTER TABLE operation_task_evidence FORCE ROW LEVEL SECURITY;
CREATE POLICY operation_task_evidence_tenant_isolation ON operation_task_evidence USING (organization_id = current_setting('app.current_organization_id',true)::uuid) WITH CHECK (organization_id = current_setting('app.current_organization_id',true)::uuid);
CREATE TRIGGER operation_task_evidence_no_delete BEFORE DELETE ON operation_task_evidence FOR EACH ROW EXECUTE FUNCTION app_operation_immutable();

ALTER TABLE operation_issue ENABLE ROW LEVEL SECURITY;
ALTER TABLE operation_issue FORCE ROW LEVEL SECURITY;
CREATE POLICY operation_issue_tenant_isolation ON operation_issue USING (organization_id = current_setting('app.current_organization_id',true)::uuid) WITH CHECK (organization_id = current_setting('app.current_organization_id',true)::uuid);
CREATE TRIGGER operation_issue_no_delete BEFORE DELETE ON operation_issue FOR EACH ROW EXECUTE FUNCTION app_operation_immutable();
CREATE TRIGGER operation_task_evidence_no_update BEFORE UPDATE ON operation_task_evidence FOR EACH ROW EXECUTE FUNCTION app_operation_immutable();
