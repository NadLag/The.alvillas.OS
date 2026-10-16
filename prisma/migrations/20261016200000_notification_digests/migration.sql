-- AlterTable
ALTER TABLE "notification_delivery" ADD COLUMN     "channel" TEXT NOT NULL DEFAULT 'push',
ADD COLUMN     "delivered_at" TIMESTAMPTZ(6),
ADD COLUMN     "payload_encrypted" TEXT,
ADD COLUMN     "prepared_at" TIMESTAMPTZ(6),
ADD COLUMN     "provider_id" TEXT,
ADD COLUMN     "scheduled_at" TIMESTAMPTZ(6);

-- AlterTable
ALTER TABLE "notification_preference" ADD COLUMN     "digest_next_at" TIMESTAMPTZ(6),
ADD COLUMN     "digest_revision" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "digest_settings" JSONB;

-- AlterTable
ALTER TABLE "notification" ADD COLUMN     "digest_delivery_id" UUID;

-- CreateIndex
CREATE INDEX "notification_delivery_channel_status_idx" ON "notification_delivery"("organization_id", "channel", "status", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "notification_delivery_tenant_account_id_unique" ON "notification_delivery"("organization_id", "user_account_id", "id");

-- CreateIndex
CREATE INDEX "notification_preference_digest_due_idx" ON "notification_preference"("organization_id", "digest_next_at", "user_account_id");

-- CreateIndex
CREATE INDEX "notification_digest_unread_idx" ON "notification"("organization_id", "recipient_id", "digest_delivery_id", "read_at", "created_at", "id");

-- AddForeignKey
ALTER TABLE "notification" ADD CONSTRAINT "notification_organization_id_recipient_id_digest_delivery__fkey" FOREIGN KEY ("organization_id", "recipient_id", "digest_delivery_id") REFERENCES "notification_delivery"("organization_id", "user_account_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

ALTER TABLE notification_preference ADD CONSTRAINT notification_preference_digest_revision_check CHECK (digest_revision >= 0);
ALTER TABLE notification_delivery ADD CONSTRAINT notification_delivery_channel_check CHECK (channel IN ('push', 'digest'));
ALTER TABLE notification_delivery DROP CONSTRAINT notification_delivery_status_check;
ALTER TABLE notification_delivery ADD CONSTRAINT notification_delivery_status_check CHECK (status IN ('PENDING','ACCEPTED','DELIVERED','FAILED','SUPPRESSED','NO_SUBSCRIPTION'));

-- Preserve existing push immutability and expand only the digest receipt path.
CREATE OR REPLACE FUNCTION app_protect_push_history() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'push history cannot be deleted'; END IF;
 IF ROW(NEW.id, NEW.organization_id, NEW.user_account_id, NEW.event_id, NEW.subscription_id, NEW.delivery_key, NEW.kind, NEW.created_at, NEW.channel, NEW.scheduled_at)
   IS DISTINCT FROM ROW(OLD.id, OLD.organization_id, OLD.user_account_id, OLD.event_id, OLD.subscription_id, OLD.delivery_key, OLD.kind, OLD.created_at, OLD.channel, OLD.scheduled_at)
   OR NEW.attempt_count < OLD.attempt_count
   OR (OLD.status <> 'PENDING' AND NEW.status <> OLD.status AND NOT (OLD.channel = 'digest' AND OLD.status = 'ACCEPTED' AND NEW.status IN ('DELIVERED','FAILED')))
   OR (OLD.accepted_at IS NOT NULL AND NEW.accepted_at IS DISTINCT FROM OLD.accepted_at)
   OR (OLD.displayed_at IS NOT NULL AND NEW.displayed_at IS DISTINCT FROM OLD.displayed_at)
   OR (OLD.opened_at IS NOT NULL AND NEW.opened_at IS DISTINCT FROM OLD.opened_at)
   OR (OLD.prepared_at IS NOT NULL AND NEW.prepared_at IS DISTINCT FROM OLD.prepared_at)
   OR (OLD.payload_encrypted IS NOT NULL AND NEW.payload_encrypted IS DISTINCT FROM OLD.payload_encrypted)
   OR (OLD.provider_id IS NOT NULL AND NEW.provider_id IS DISTINCT FROM OLD.provider_id)
   OR (OLD.delivered_at IS NOT NULL AND NEW.delivered_at IS DISTINCT FROM OLD.delivered_at) THEN
   RAISE EXCEPTION 'push delivery history cannot be rewritten';
 END IF;
 RETURN NEW;
END $$;

CREATE FUNCTION app_protect_notification_digest_claim() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD.digest_delivery_id IS NOT NULL AND NEW.digest_delivery_id IS DISTINCT FROM OLD.digest_delivery_id THEN
   RAISE EXCEPTION 'notification digest ownership cannot be rewritten';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER notification_digest_claim_history BEFORE UPDATE ON notification
 FOR EACH ROW EXECUTE FUNCTION app_protect_notification_digest_claim();
