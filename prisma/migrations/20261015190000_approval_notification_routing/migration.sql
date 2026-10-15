-- AlterTable
ALTER TABLE "notification_preference" ADD COLUMN     "email_account" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "email_enabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "email_operations" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "push_account" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "push_enabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "push_operations" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "notification" ADD COLUMN     "resolution" TEXT,
ADD COLUMN     "resolved_at" TIMESTAMPTZ(6);

-- CreateTable
CREATE TABLE "approval_request" (
    "id" UUID NOT NULL DEFAULT app_uuid_v7(),
    "organization_id" UUID NOT NULL,
    "property_id" UUID NOT NULL,
    "requested_by" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "details" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'PENDING',
    "routing_snapshot" JSONB NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "decided_by" UUID,
    "decision_reason" TEXT,
    "decided_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "approval_request_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "approval_recipient" (
    "id" UUID NOT NULL DEFAULT app_uuid_v7(),
    "organization_id" UUID NOT NULL,
    "approval_id" UUID NOT NULL,
    "user_account_id" UUID NOT NULL,

    CONSTRAINT "approval_recipient_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "approval_request_organization_id_property_id_state_created__idx" ON "approval_request"("organization_id", "property_id", "state", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "approval_request_organization_id_id_key" ON "approval_request"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "approval_request_organization_id_idempotency_key_key" ON "approval_request"("organization_id", "idempotency_key");

-- CreateIndex
CREATE UNIQUE INDEX "approval_recipient_organization_id_approval_id_user_account_key" ON "approval_recipient"("organization_id", "approval_id", "user_account_id");

-- AddForeignKey
ALTER TABLE "approval_request" ADD CONSTRAINT "approval_request_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "approval_request" ADD CONSTRAINT "approval_request_property_id_fkey" FOREIGN KEY ("property_id") REFERENCES "property"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "approval_recipient" ADD CONSTRAINT "approval_recipient_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "approval_recipient" ADD CONSTRAINT "approval_recipient_organization_id_approval_id_fkey" FOREIGN KEY ("organization_id", "approval_id") REFERENCES "approval_request"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "approval_recipient" ADD CONSTRAINT "approval_recipient_organization_id_user_account_id_fkey" FOREIGN KEY ("organization_id", "user_account_id") REFERENCES "user_account"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

ALTER TABLE notification DROP CONSTRAINT notification_kind_check;
ALTER TABLE notification ADD CONSTRAINT notification_kind_check CHECK (kind IN ('language_updated','task_assigned','task_completed','reservation_created','security_session_revoked','approval_requested','approval_decided'));
ALTER TABLE notification ADD CONSTRAINT notification_resolution_check CHECK ((resolution IS NULL AND resolved_at IS NULL) OR (resolution IN ('APPROVED','REJECTED') AND resolved_at IS NOT NULL));
ALTER TABLE approval_request ADD CONSTRAINT approval_state_check CHECK ((state = 'PENDING' AND decided_by IS NULL AND decided_at IS NULL AND decision_reason IS NULL) OR (state IN ('APPROVED','REJECTED') AND decided_by IS NOT NULL AND decided_at IS NOT NULL AND decision_reason IS NOT NULL));
ALTER TABLE approval_request ADD CONSTRAINT approval_request_requester_tenant_fk FOREIGN KEY (organization_id, requested_by) REFERENCES user_account(organization_id,id) ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE approval_request ADD CONSTRAINT approval_request_decider_tenant_fk FOREIGN KEY (organization_id, decided_by) REFERENCES user_account(organization_id,id) ON DELETE RESTRICT ON UPDATE NO ACTION;
CREATE FUNCTION app_validate_approval_property() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS (SELECT 1 FROM property WHERE id=NEW.property_id AND organization_id=NEW.organization_id) THEN RAISE EXCEPTION 'approval property tenant mismatch'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER approval_property_tenant BEFORE INSERT ON approval_request FOR EACH ROW EXECUTE FUNCTION app_validate_approval_property();
CREATE FUNCTION app_protect_approval_history() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'approval history cannot be deleted'; END IF;
 IF TG_TABLE_NAME='approval_recipient' THEN RAISE EXCEPTION 'approval recipients are immutable'; END IF;
 IF OLD.state <> 'PENDING' OR ROW(NEW.id,NEW.organization_id,NEW.property_id,NEW.requested_by,NEW.title,NEW.details,NEW.routing_snapshot,NEW.idempotency_key,NEW.created_at) IS DISTINCT FROM ROW(OLD.id,OLD.organization_id,OLD.property_id,OLD.requested_by,OLD.title,OLD.details,OLD.routing_snapshot,OLD.idempotency_key,OLD.created_at) THEN RAISE EXCEPTION 'approval history is immutable'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER approval_history BEFORE UPDATE OR DELETE ON approval_request FOR EACH ROW EXECUTE FUNCTION app_protect_approval_history();
CREATE TRIGGER approval_recipient_history BEFORE UPDATE OR DELETE ON approval_recipient FOR EACH ROW EXECUTE FUNCTION app_protect_approval_history();
CREATE FUNCTION app_protect_notification_resolution() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD.resolved_at IS NOT NULL AND ROW(NEW.resolved_at,NEW.resolution) IS DISTINCT FROM ROW(OLD.resolved_at,OLD.resolution) THEN RAISE EXCEPTION 'notification resolution is immutable'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER notification_resolution_history BEFORE UPDATE ON notification FOR EACH ROW EXECUTE FUNCTION app_protect_notification_resolution();
ALTER TABLE approval_request ENABLE ROW LEVEL SECURITY;
ALTER TABLE approval_request FORCE ROW LEVEL SECURITY;
CREATE POLICY approval_request_tenant_isolation ON approval_request USING (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid) WITH CHECK (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid);
ALTER TABLE approval_recipient ENABLE ROW LEVEL SECURITY;
ALTER TABLE approval_recipient FORCE ROW LEVEL SECURITY;
CREATE POLICY approval_recipient_tenant_isolation ON approval_recipient USING (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid) WITH CHECK (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid);
