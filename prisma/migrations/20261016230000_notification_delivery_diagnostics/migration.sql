-- AlterTable
ALTER TABLE "notification_delivery" ADD COLUMN     "recipient_key" TEXT,
ALTER COLUMN "user_account_id" DROP NOT NULL;

-- CreateTable
CREATE TABLE "notification_delivery_log" (
    "id" UUID NOT NULL DEFAULT app_uuid_v7(),
    "organization_id" UUID NOT NULL,
    "delivery_id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "outcome" TEXT NOT NULL,
    "attempt" INTEGER,
    "provider_status" INTEGER,
    "code" TEXT,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notification_delivery_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification_email_suppression" (
    "id" UUID NOT NULL DEFAULT app_uuid_v7(),
    "organization_id" UUID NOT NULL,
    "recipient_key" TEXT NOT NULL,
    "delivery_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notification_email_suppression_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "notification_delivery_log_history_idx" ON "notification_delivery_log"("organization_id", "delivery_id", "created_at" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "notification_delivery_log_receipt_idx" ON "notification_delivery_log"("organization_id", "key");

-- CreateIndex
CREATE UNIQUE INDEX "notification_delivery_log_key_unique" ON "notification_delivery_log"("organization_id", "delivery_id", "key");

-- CreateIndex
CREATE UNIQUE INDEX "notification_email_suppression_recipient_unique" ON "notification_email_suppression"("organization_id", "recipient_key");

-- CreateIndex
CREATE UNIQUE INDEX "notification_delivery_org_id_unique" ON "notification_delivery"("organization_id", "id");
CREATE INDEX "notification_delivery_admin_history_idx" ON "notification_delivery"("organization_id", "created_at" DESC, "id" DESC);
CREATE INDEX "notification_delivery_admin_channel_idx" ON "notification_delivery"("organization_id", "channel", "created_at" DESC, "id" DESC);

-- AddForeignKey
ALTER TABLE "notification_delivery_log" ADD CONSTRAINT "notification_delivery_log_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "notification_delivery_log" ADD CONSTRAINT "notification_delivery_log_organization_id_delivery_id_fkey" FOREIGN KEY ("organization_id", "delivery_id") REFERENCES "notification_delivery"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "notification_email_suppression" ADD CONSTRAINT "notification_email_suppression_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "notification_email_suppression" ADD CONSTRAINT "notification_email_suppression_organization_id_delivery_id_fkey" FOREIGN KEY ("organization_id", "delivery_id") REFERENCES "notification_delivery"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

ALTER TABLE notification_delivery DROP CONSTRAINT notification_delivery_channel_check;
ALTER TABLE notification_delivery ADD CONSTRAINT notification_delivery_channel_check CHECK (channel IN ('push','digest','email'));
ALTER TABLE notification_delivery ADD CONSTRAINT notification_delivery_account_check CHECK (channel = 'email' OR user_account_id IS NOT NULL);
ALTER TABLE notification_delivery DROP CONSTRAINT notification_delivery_status_check;
ALTER TABLE notification_delivery ADD CONSTRAINT notification_delivery_status_check CHECK (status IN ('PENDING','ACCEPTED','DELIVERED','FAILED','BOUNCED','COMPLAINED','SUPPRESSED','NO_SUBSCRIPTION'));
ALTER TABLE notification_delivery_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification_delivery_log FORCE ROW LEVEL SECURITY;
CREATE POLICY notification_delivery_log_tenant_isolation ON notification_delivery_log
 USING (organization_id = current_setting('app.current_organization_id', true)::uuid)
 WITH CHECK (organization_id = current_setting('app.current_organization_id', true)::uuid);
ALTER TABLE notification_email_suppression ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification_email_suppression FORCE ROW LEVEL SECURITY;
CREATE POLICY notification_email_suppression_tenant_isolation ON notification_email_suppression
 USING (organization_id = current_setting('app.current_organization_id', true)::uuid)
 WITH CHECK (organization_id = current_setting('app.current_organization_id', true)::uuid);
CREATE FUNCTION app_protect_notification_delivery_log() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'notification delivery evidence is append-only'; END $$;
CREATE TRIGGER notification_delivery_log_immutable BEFORE UPDATE OR DELETE ON notification_delivery_log
 FOR EACH ROW EXECUTE FUNCTION app_protect_notification_delivery_log();
CREATE TRIGGER notification_email_suppression_immutable BEFORE UPDATE OR DELETE ON notification_email_suppression
 FOR EACH ROW EXECUTE FUNCTION app_protect_notification_delivery_log();
CREATE OR REPLACE FUNCTION app_protect_push_history() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'push history cannot be deleted'; END IF;
 IF ROW(NEW.id, NEW.organization_id, NEW.user_account_id, NEW.event_id, NEW.subscription_id, NEW.delivery_key, NEW.kind, NEW.created_at, NEW.channel, NEW.scheduled_at)
   IS DISTINCT FROM ROW(OLD.id, OLD.organization_id, OLD.user_account_id, OLD.event_id, OLD.subscription_id, OLD.delivery_key, OLD.kind, OLD.created_at, OLD.channel, OLD.scheduled_at)
   OR NEW.attempt_count < OLD.attempt_count
   OR (OLD.status <> 'PENDING' AND NEW.status <> OLD.status AND NOT (
       OLD.channel IN ('digest','email') AND (
         (OLD.status = 'ACCEPTED' AND NEW.status IN ('DELIVERED','FAILED','BOUNCED','COMPLAINED')) OR
         (OLD.status IN ('DELIVERED','FAILED') AND NEW.status IN ('BOUNCED','COMPLAINED')) OR
         (OLD.status = 'BOUNCED' AND NEW.status = 'COMPLAINED'))))
   OR (OLD.accepted_at IS NOT NULL AND NEW.accepted_at IS DISTINCT FROM OLD.accepted_at)
   OR (OLD.displayed_at IS NOT NULL AND NEW.displayed_at IS DISTINCT FROM OLD.displayed_at)
   OR (OLD.opened_at IS NOT NULL AND NEW.opened_at IS DISTINCT FROM OLD.opened_at)
   OR (OLD.prepared_at IS NOT NULL AND NEW.prepared_at IS DISTINCT FROM OLD.prepared_at)
   OR (OLD.payload_encrypted IS NOT NULL AND NEW.payload_encrypted IS DISTINCT FROM OLD.payload_encrypted)
   OR (OLD.recipient_key IS NOT NULL AND NEW.recipient_key IS DISTINCT FROM OLD.recipient_key)
   OR (OLD.provider_id IS NOT NULL AND NEW.provider_id IS DISTINCT FROM OLD.provider_id)
   OR (OLD.delivered_at IS NOT NULL AND NEW.delivered_at IS DISTINCT FROM OLD.delivered_at) THEN
   RAISE EXCEPTION 'push delivery history cannot be rewritten';
 END IF;
 RETURN NEW;
END $$;
