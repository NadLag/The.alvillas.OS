-- CreateTable
CREATE TABLE "push_subscription" (
    "id" UUID NOT NULL DEFAULT app_uuid_v7(),
    "organization_id" UUID NOT NULL,
    "user_account_id" UUID NOT NULL,
    "session_id" UUID NOT NULL,
    "endpoint_hash" TEXT NOT NULL,
    "encrypted" TEXT NOT NULL,
    "vapid_public_key" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ(6),
    "revoked_at" TIMESTAMPTZ(6),
    "revoked_reason" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "push_subscription_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification_delivery" (
    "id" UUID NOT NULL DEFAULT app_uuid_v7(),
    "organization_id" UUID NOT NULL,
    "user_account_id" UUID NOT NULL,
    "event_id" UUID NOT NULL,
    "subscription_id" UUID,
    "delivery_key" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "attempt_count" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMPTZ(6),
    "provider_status" INTEGER,
    "error_code" TEXT,
    "accepted_at" TIMESTAMPTZ(6),
    "displayed_at" TIMESTAMPTZ(6),
    "opened_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notification_delivery_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "push_subscription_recipient_idx" ON "push_subscription"("organization_id", "user_account_id", "revoked_at");

-- CreateIndex
CREATE UNIQUE INDEX "push_subscription_tenant_account_id_unique" ON "push_subscription"("organization_id", "user_account_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "push_subscription_org_endpoint_unique" ON "push_subscription"("organization_id", "endpoint_hash");

-- CreateIndex
CREATE INDEX "notification_delivery_history_idx" ON "notification_delivery"("organization_id", "user_account_id", "created_at" DESC, "id" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "notification_delivery_event_device_unique" ON "notification_delivery"("organization_id", "event_id", "delivery_key");

-- CreateIndex
CREATE UNIQUE INDEX "auth_session_tenant_account_id_unique" ON "auth_session"("organization_id", "user_account_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "outbox_event_org_id_unique" ON "outbox_event"("organization_id", "id");

-- AddForeignKey
ALTER TABLE "push_subscription" ADD CONSTRAINT "push_subscription_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "push_subscription" ADD CONSTRAINT "push_subscription_organization_id_user_account_id_fkey" FOREIGN KEY ("organization_id", "user_account_id") REFERENCES "user_account"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "push_subscription" ADD CONSTRAINT "push_subscription_organization_id_user_account_id_session__fkey" FOREIGN KEY ("organization_id", "user_account_id", "session_id") REFERENCES "auth_session"("organization_id", "user_account_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "notification_delivery" ADD CONSTRAINT "notification_delivery_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "notification_delivery" ADD CONSTRAINT "notification_delivery_organization_id_user_account_id_fkey" FOREIGN KEY ("organization_id", "user_account_id") REFERENCES "user_account"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "notification_delivery" ADD CONSTRAINT "notification_delivery_organization_id_event_id_fkey" FOREIGN KEY ("organization_id", "event_id") REFERENCES "outbox_event"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "notification_delivery" ADD CONSTRAINT "notification_delivery_organization_id_user_account_id_subs_fkey" FOREIGN KEY ("organization_id", "user_account_id", "subscription_id") REFERENCES "push_subscription"("organization_id", "user_account_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;


ALTER TABLE push_subscription ENABLE ROW LEVEL SECURITY;
ALTER TABLE push_subscription FORCE ROW LEVEL SECURITY;
CREATE POLICY push_subscription_tenant_isolation ON push_subscription
 USING (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid)
 WITH CHECK (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid);

ALTER TABLE notification_delivery ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification_delivery FORCE ROW LEVEL SECURITY;
CREATE POLICY notification_delivery_tenant_isolation ON notification_delivery
 USING (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid)
 WITH CHECK (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid);

ALTER TABLE notification_delivery ADD CONSTRAINT notification_delivery_status_check
 CHECK (status IN ('PENDING','ACCEPTED','FAILED','SUPPRESSED','NO_SUBSCRIPTION'));
ALTER TABLE notification_delivery ADD CONSTRAINT notification_delivery_attempt_check CHECK (attempt_count >= 0);
CREATE FUNCTION app_protect_push_history() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'push history cannot be deleted'; END IF;
 IF ROW(NEW.id, NEW.organization_id, NEW.user_account_id, NEW.event_id, NEW.subscription_id, NEW.delivery_key, NEW.kind, NEW.created_at)
   IS DISTINCT FROM ROW(OLD.id, OLD.organization_id, OLD.user_account_id, OLD.event_id, OLD.subscription_id, OLD.delivery_key, OLD.kind, OLD.created_at)
   OR NEW.attempt_count < OLD.attempt_count
   OR (OLD.status <> 'PENDING' AND NEW.status <> OLD.status)
   OR (OLD.accepted_at IS NOT NULL AND NEW.accepted_at IS DISTINCT FROM OLD.accepted_at)
   OR (OLD.displayed_at IS NOT NULL AND NEW.displayed_at IS DISTINCT FROM OLD.displayed_at)
   OR (OLD.opened_at IS NOT NULL AND NEW.opened_at IS DISTINCT FROM OLD.opened_at) THEN
   RAISE EXCEPTION 'push delivery history cannot be rewritten';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER notification_delivery_history BEFORE UPDATE OR DELETE ON notification_delivery
 FOR EACH ROW EXECUTE FUNCTION app_protect_push_history();
CREATE FUNCTION app_protect_push_subscription() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'push subscription history cannot be deleted'; END IF;
 IF ROW(NEW.id, NEW.organization_id, NEW.user_account_id, NEW.endpoint_hash, NEW.created_at)
   IS DISTINCT FROM ROW(OLD.id, OLD.organization_id, OLD.user_account_id, OLD.endpoint_hash, OLD.created_at) THEN
   RAISE EXCEPTION 'push subscription ownership cannot be changed';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER push_subscription_history BEFORE UPDATE OR DELETE ON push_subscription
 FOR EACH ROW EXECUTE FUNCTION app_protect_push_subscription();
