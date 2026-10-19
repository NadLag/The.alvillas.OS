-- AlterTable
ALTER TABLE "reservation" ADD COLUMN     "cancellation_suspected_at" TIMESTAMPTZ(6),
ADD COLUMN     "confirmed_at" TIMESTAMPTZ(6),
ADD COLUMN     "guest_id" UUID,
ADD COLUMN     "version" INTEGER NOT NULL DEFAULT 1;

-- CreateTable
CREATE TABLE "guest" (
    "id" UUID NOT NULL DEFAULT app_uuid_v7(),
    "organization_id" UUID NOT NULL,
    "display_name" TEXT,
    "email" TEXT,
    "phone" TEXT,
    "merged_into_id" UUID,
    "archived_at" TIMESTAMPTZ(6),
    "created_by" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "guest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reservation_feed" (
    "id" UUID NOT NULL DEFAULT app_uuid_v7(),
    "organization_id" UUID NOT NULL,
    "property_id" UUID NOT NULL,
    "source" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "booking_channel_id" UUID NOT NULL,
    "etag" TEXT,
    "last_modified" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "next_sync_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_success_at" TIMESTAMPTZ(6),
    "last_attempt_at" TIMESTAMPTZ(6),
    "consecutive_failures" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,
    "lease_token" UUID,
    "leased_until" TIMESTAMPTZ(6),
    "idempotency_key" TEXT NOT NULL,
    "archived_at" TIMESTAMPTZ(6),
    "created_by" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reservation_feed_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reservation_feed_entry" (
    "id" UUID NOT NULL DEFAULT app_uuid_v7(),
    "organization_id" UUID NOT NULL,
    "feed_id" UUID NOT NULL,
    "external_key" TEXT NOT NULL,
    "reservation_id" UUID,
    "block_id" UUID,
    "missing_runs" INTEGER NOT NULL DEFAULT 0,
    "last_seen_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sequence" INTEGER,
    "content_hash" TEXT NOT NULL,
    "suppressed" BOOLEAN NOT NULL DEFAULT false,
    "created_by" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reservation_feed_entry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "feed_sync_run" (
    "id" UUID NOT NULL DEFAULT app_uuid_v7(),
    "organization_id" UUID NOT NULL,
    "feed_id" UUID NOT NULL,
    "status" TEXT NOT NULL,
    "imported" INTEGER NOT NULL DEFAULT 0,
    "modified" INTEGER NOT NULL DEFAULT 0,
    "suspected" INTEGER NOT NULL DEFAULT 0,
    "error_code" TEXT,
    "created_by" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "feed_sync_run_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reservation_revision" (
    "id" UUID NOT NULL DEFAULT app_uuid_v7(),
    "organization_id" UUID NOT NULL,
    "reservation_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "operation" TEXT NOT NULL,
    "before" JSONB NOT NULL,
    "after" JSONB NOT NULL,
    "reason" TEXT NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "created_by" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reservation_revision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reservation_financial_snapshot" (
    "id" UUID NOT NULL DEFAULT app_uuid_v7(),
    "organization_id" UUID NOT NULL,
    "reservation_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "amount" DECIMAL(18,2),
    "currency" CHAR(3),
    "rules" JSONB NOT NULL,
    "created_by" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reservation_financial_snapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "calendar_block" (
    "id" UUID NOT NULL DEFAULT app_uuid_v7(),
    "organization_id" UUID NOT NULL,
    "property_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "external_id" TEXT,
    "check_in" DATE NOT NULL,
    "check_out" DATE NOT NULL,
    "reason" TEXT,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "idempotency_key" TEXT NOT NULL,
    "archived_at" TIMESTAMPTZ(6),
    "created_by" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "calendar_block_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reservation_import_batch" (
    "id" UUID NOT NULL DEFAULT app_uuid_v7(),
    "organization_id" UUID NOT NULL,
    "property_id" UUID NOT NULL,
    "source" TEXT NOT NULL,
    "content_hash" TEXT NOT NULL,
    "imported" INTEGER NOT NULL,
    "modified" INTEGER NOT NULL,
    "duplicates" INTEGER NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "created_by" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reservation_import_batch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reservation_exception" (
    "id" UUID NOT NULL DEFAULT app_uuid_v7(),
    "organization_id" UUID NOT NULL,
    "property_id" UUID NOT NULL,
    "reservation_id" UUID,
    "kind" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "details" JSONB NOT NULL,
    "key" TEXT NOT NULL,
    "resolution" TEXT,
    "resolved_by" UUID,
    "created_by" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reservation_exception_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "guest_org_email_idx" ON "guest"("organization_id", "email");

-- CreateIndex
CREATE INDEX "guest_org_phone_idx" ON "guest"("organization_id", "phone");

-- CreateIndex
CREATE INDEX "reservation_feed_org_due_idx" ON "reservation_feed"("organization_id", "enabled", "next_sync_at");

-- CreateIndex
CREATE UNIQUE INDEX "reservation_feed_org_idempotency_unique" ON "reservation_feed"("organization_id", "idempotency_key");

-- CreateIndex
CREATE UNIQUE INDEX "reservation_feed_org_channel_unique" ON "reservation_feed"("organization_id", "booking_channel_id");

-- CreateIndex
CREATE INDEX "reservation_feed_entry_org_reservation_idx" ON "reservation_feed_entry"("organization_id", "reservation_id");

-- CreateIndex
CREATE UNIQUE INDEX "reservation_feed_entry_identity_unique" ON "reservation_feed_entry"("organization_id", "feed_id", "external_key");

-- CreateIndex
CREATE INDEX "feed_sync_run_org_feed_created_idx" ON "feed_sync_run"("organization_id", "feed_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "reservation_revision_org_reservation_version_unique" ON "reservation_revision"("organization_id", "reservation_id", "version");

-- CreateIndex
CREATE UNIQUE INDEX "reservation_revision_org_idempotency_unique" ON "reservation_revision"("organization_id", "idempotency_key");

-- CreateIndex
CREATE UNIQUE INDEX "reservation_financial_snapshot_org_version_unique" ON "reservation_financial_snapshot"("organization_id", "reservation_id", "version");

-- CreateIndex
CREATE INDEX "calendar_block_org_property_dates_idx" ON "calendar_block"("organization_id", "property_id", "check_in", "check_out");

-- CreateIndex
CREATE UNIQUE INDEX "calendar_block_org_idempotency_unique" ON "calendar_block"("organization_id", "idempotency_key");

-- CreateIndex
CREATE UNIQUE INDEX "reservation_import_batch_content_unique" ON "reservation_import_batch"("organization_id", "property_id", "source", "content_hash");

-- CreateIndex
CREATE UNIQUE INDEX "reservation_import_batch_idempotency_unique" ON "reservation_import_batch"("organization_id", "idempotency_key");

-- CreateIndex
CREATE INDEX "reservation_exception_org_status_idx" ON "reservation_exception"("organization_id", "property_id", "status", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "reservation_exception_org_key_unique" ON "reservation_exception"("organization_id", "key");

ALTER TABLE guest ADD CONSTRAINT guest_organization_fk FOREIGN KEY (organization_id) REFERENCES organization(id) ON DELETE RESTRICT;
ALTER TABLE guest ENABLE ROW LEVEL SECURITY;
ALTER TABLE guest FORCE ROW LEVEL SECURITY;
CREATE POLICY guest_tenant_isolation ON guest
 USING (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid)
 WITH CHECK (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid);

ALTER TABLE reservation_feed ADD CONSTRAINT reservation_feed_organization_fk FOREIGN KEY (organization_id) REFERENCES organization(id) ON DELETE RESTRICT;
ALTER TABLE reservation_feed ENABLE ROW LEVEL SECURITY;
ALTER TABLE reservation_feed FORCE ROW LEVEL SECURITY;
CREATE POLICY reservation_feed_tenant_isolation ON reservation_feed
 USING (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid)
 WITH CHECK (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid);

ALTER TABLE reservation_feed_entry ADD CONSTRAINT reservation_feed_entry_organization_fk FOREIGN KEY (organization_id) REFERENCES organization(id) ON DELETE RESTRICT;
ALTER TABLE reservation_feed_entry ENABLE ROW LEVEL SECURITY;
ALTER TABLE reservation_feed_entry FORCE ROW LEVEL SECURITY;
CREATE POLICY reservation_feed_entry_tenant_isolation ON reservation_feed_entry
 USING (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid)
 WITH CHECK (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid);

ALTER TABLE feed_sync_run ADD CONSTRAINT feed_sync_run_organization_fk FOREIGN KEY (organization_id) REFERENCES organization(id) ON DELETE RESTRICT;
ALTER TABLE feed_sync_run ENABLE ROW LEVEL SECURITY;
ALTER TABLE feed_sync_run FORCE ROW LEVEL SECURITY;
CREATE POLICY feed_sync_run_tenant_isolation ON feed_sync_run
 USING (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid)
 WITH CHECK (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid);

ALTER TABLE reservation_revision ADD CONSTRAINT reservation_revision_organization_fk FOREIGN KEY (organization_id) REFERENCES organization(id) ON DELETE RESTRICT;
ALTER TABLE reservation_revision ENABLE ROW LEVEL SECURITY;
ALTER TABLE reservation_revision FORCE ROW LEVEL SECURITY;
CREATE POLICY reservation_revision_tenant_isolation ON reservation_revision
 USING (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid)
 WITH CHECK (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid);

ALTER TABLE reservation_financial_snapshot ADD CONSTRAINT reservation_financial_snapshot_organization_fk FOREIGN KEY (organization_id) REFERENCES organization(id) ON DELETE RESTRICT;
ALTER TABLE reservation_financial_snapshot ENABLE ROW LEVEL SECURITY;
ALTER TABLE reservation_financial_snapshot FORCE ROW LEVEL SECURITY;
CREATE POLICY reservation_financial_snapshot_tenant_isolation ON reservation_financial_snapshot
 USING (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid)
 WITH CHECK (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid);

ALTER TABLE calendar_block ADD CONSTRAINT calendar_block_organization_fk FOREIGN KEY (organization_id) REFERENCES organization(id) ON DELETE RESTRICT;
ALTER TABLE calendar_block ENABLE ROW LEVEL SECURITY;
ALTER TABLE calendar_block FORCE ROW LEVEL SECURITY;
CREATE POLICY calendar_block_tenant_isolation ON calendar_block
 USING (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid)
 WITH CHECK (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid);

ALTER TABLE reservation_import_batch ADD CONSTRAINT reservation_import_batch_organization_fk FOREIGN KEY (organization_id) REFERENCES organization(id) ON DELETE RESTRICT;
ALTER TABLE reservation_import_batch ENABLE ROW LEVEL SECURITY;
ALTER TABLE reservation_import_batch FORCE ROW LEVEL SECURITY;
CREATE POLICY reservation_import_batch_tenant_isolation ON reservation_import_batch
 USING (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid)
 WITH CHECK (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid);

ALTER TABLE reservation_exception ADD CONSTRAINT reservation_exception_organization_fk FOREIGN KEY (organization_id) REFERENCES organization(id) ON DELETE RESTRICT;
ALTER TABLE reservation_exception ENABLE ROW LEVEL SECURITY;
ALTER TABLE reservation_exception FORCE ROW LEVEL SECURITY;
CREATE POLICY reservation_exception_tenant_isolation ON reservation_exception
 USING (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid)
 WITH CHECK (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid);
CREATE UNIQUE INDEX IF NOT EXISTS guest_org_id_unique ON guest (organization_id,id);
CREATE UNIQUE INDEX IF NOT EXISTS reservation_feed_org_id_unique ON reservation_feed (organization_id,id);
CREATE UNIQUE INDEX IF NOT EXISTS calendar_block_org_id_unique ON calendar_block (organization_id,id);
CREATE UNIQUE INDEX IF NOT EXISTS reservation_org_id_unique ON reservation (organization_id,id);
CREATE UNIQUE INDEX IF NOT EXISTS property_org_id_unique ON property (organization_id,id);
ALTER TABLE reservation ADD CONSTRAINT reservation_guest_id_tenant_fk FOREIGN KEY (organization_id,guest_id) REFERENCES guest(organization_id,id) ON DELETE RESTRICT;
ALTER TABLE guest ADD CONSTRAINT guest_merged_into_id_tenant_fk FOREIGN KEY (organization_id,merged_into_id) REFERENCES guest(organization_id,id) ON DELETE RESTRICT;
ALTER TABLE reservation_feed ADD CONSTRAINT reservation_feed_property_id_tenant_fk FOREIGN KEY (organization_id,property_id) REFERENCES property(organization_id,id) ON DELETE RESTRICT;
ALTER TABLE reservation_feed_entry ADD CONSTRAINT reservation_feed_entry_feed_id_tenant_fk FOREIGN KEY (organization_id,feed_id) REFERENCES reservation_feed(organization_id,id) ON DELETE RESTRICT;
ALTER TABLE reservation_feed_entry ADD CONSTRAINT reservation_feed_entry_reservation_id_tenant_fk FOREIGN KEY (organization_id,reservation_id) REFERENCES reservation(organization_id,id) ON DELETE RESTRICT;
ALTER TABLE reservation_feed_entry ADD CONSTRAINT reservation_feed_entry_block_id_tenant_fk FOREIGN KEY (organization_id,block_id) REFERENCES calendar_block(organization_id,id) ON DELETE RESTRICT;
ALTER TABLE feed_sync_run ADD CONSTRAINT feed_sync_run_feed_id_tenant_fk FOREIGN KEY (organization_id,feed_id) REFERENCES reservation_feed(organization_id,id) ON DELETE RESTRICT;
ALTER TABLE reservation_revision ADD CONSTRAINT reservation_revision_reservation_id_tenant_fk FOREIGN KEY (organization_id,reservation_id) REFERENCES reservation(organization_id,id) ON DELETE RESTRICT;
ALTER TABLE reservation_financial_snapshot ADD CONSTRAINT reservation_financial_snapshot_reservation_id_tenant_fk FOREIGN KEY (organization_id,reservation_id) REFERENCES reservation(organization_id,id) ON DELETE RESTRICT;
ALTER TABLE calendar_block ADD CONSTRAINT calendar_block_property_id_tenant_fk FOREIGN KEY (organization_id,property_id) REFERENCES property(organization_id,id) ON DELETE RESTRICT;
ALTER TABLE reservation_import_batch ADD CONSTRAINT reservation_import_batch_property_id_tenant_fk FOREIGN KEY (organization_id,property_id) REFERENCES property(organization_id,id) ON DELETE RESTRICT;
ALTER TABLE reservation_exception ADD CONSTRAINT reservation_exception_property_id_tenant_fk FOREIGN KEY (organization_id,property_id) REFERENCES property(organization_id,id) ON DELETE RESTRICT;
ALTER TABLE reservation_exception ADD CONSTRAINT reservation_exception_reservation_id_tenant_fk FOREIGN KEY (organization_id,reservation_id) REFERENCES reservation(organization_id,id) ON DELETE RESTRICT;
CREATE TRIGGER reservation_revision_no_update BEFORE UPDATE ON reservation_revision FOR EACH ROW EXECUTE FUNCTION app_prevent_config_rule_mutation();
CREATE TRIGGER reservation_revision_no_delete BEFORE DELETE ON reservation_revision FOR EACH ROW EXECUTE FUNCTION app_prevent_config_rule_mutation();
CREATE TRIGGER reservation_financial_snapshot_no_update BEFORE UPDATE ON reservation_financial_snapshot FOR EACH ROW EXECUTE FUNCTION app_prevent_config_rule_mutation();
CREATE TRIGGER reservation_financial_snapshot_no_delete BEFORE DELETE ON reservation_financial_snapshot FOR EACH ROW EXECUTE FUNCTION app_prevent_config_rule_mutation();
CREATE TRIGGER feed_sync_run_no_update BEFORE UPDATE ON feed_sync_run FOR EACH ROW EXECUTE FUNCTION app_prevent_config_rule_mutation();
CREATE TRIGGER feed_sync_run_no_delete BEFORE DELETE ON feed_sync_run FOR EACH ROW EXECUTE FUNCTION app_prevent_config_rule_mutation();
CREATE TRIGGER reservation_import_batch_no_update BEFORE UPDATE ON reservation_import_batch FOR EACH ROW EXECUTE FUNCTION app_prevent_config_rule_mutation();
CREATE TRIGGER reservation_import_batch_no_delete BEFORE DELETE ON reservation_import_batch FOR EACH ROW EXECUTE FUNCTION app_prevent_config_rule_mutation();

ALTER TABLE calendar_block ADD CONSTRAINT calendar_block_dates_check CHECK (check_out > check_in);
ALTER TABLE reservation_financial_snapshot ADD CONSTRAINT reservation_financial_snapshot_money_check CHECK (
 (amount IS NULL AND currency IS NULL) OR (amount IS NOT NULL AND currency IS NOT NULL AND amount >= 0));
ALTER TABLE reservation_feed_entry ADD CONSTRAINT reservation_feed_entry_target_check CHECK (
 (reservation_id IS NOT NULL)::int + (block_id IS NOT NULL)::int <= 1);
ALTER TABLE guest ADD CONSTRAINT guest_not_self_merged CHECK (merged_into_id IS DISTINCT FROM id);
INSERT INTO config_rule (organization_id,key,scope_type,scope_id,value,effective_from,version,reason)
 SELECT id,'reservation.sync_policy','organization',NULL,
 '{"interval_minutes":15,"missing_uid_runs":2,"stale_after_minutes":60}'::jsonb,now(),1,'Reservation sync defaults; editable through config_rule'
 FROM organization o WHERE NOT EXISTS (SELECT 1 FROM config_rule r WHERE r.organization_id=o.id AND r.key='reservation.sync_policy');

CREATE UNIQUE INDEX booking_channel_org_id_unique ON booking_channel(organization_id,id);
ALTER TABLE reservation_feed ADD CONSTRAINT reservation_feed_channel_tenant_fk FOREIGN KEY(organization_id,booking_channel_id) REFERENCES booking_channel(organization_id,id) ON DELETE RESTRICT;
