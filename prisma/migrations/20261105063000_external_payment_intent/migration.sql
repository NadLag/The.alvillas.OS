BEGIN;

-- CreateTable
CREATE TABLE "external_payment_intent" (
    "id" UUID NOT NULL DEFAULT app_uuid_v7(),
    "organization_id" UUID NOT NULL,
    "requested_by" UUID NOT NULL,
    "reservation_id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "order_id" TEXT NOT NULL,
    "source_identity" CHAR(64) NOT NULL,
    "canonical_request" TEXT NOT NULL,
    "policy_id" UUID NOT NULL,
    "policy_version" INTEGER NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "idempotency_key" UUID NOT NULL,
    "request_fingerprint" CHAR(64) NOT NULL,
    "input" JSONB NOT NULL,
    "authorization_cap" JSONB NOT NULL,
    "requested_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "external_payment_intent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "external_payment_capture" (
    "id" UUID NOT NULL DEFAULT app_uuid_v7(),
    "organization_id" UUID NOT NULL,
    "intent_id" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "payment_id" TEXT NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "evidence" JSONB NOT NULL,
    "observed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "external_payment_capture_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "external_payment_intent_source_unique" ON "external_payment_intent"("source_identity");

-- CreateIndex
CREATE INDEX "external_payment_intent_actor_idx" ON "external_payment_intent"("organization_id", "requested_by", "requested_at", "id");

-- CreateIndex
CREATE UNIQUE INDEX "external_payment_intent_org_id_unique" ON "external_payment_intent"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "external_payment_intent_key_unique" ON "external_payment_intent"("organization_id", "idempotency_key");

-- CreateIndex
CREATE UNIQUE INDEX "external_payment_capture_org_id_unique" ON "external_payment_capture"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "external_payment_capture_intent_unique" ON "external_payment_capture"("organization_id", "intent_id");

-- CreateIndex
CREATE UNIQUE INDEX "external_payment_capture_provider_unique" ON "external_payment_capture"("provider", "payment_id");

-- AddForeignKey
ALTER TABLE "external_payment_intent" ADD CONSTRAINT "external_payment_intent_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "external_payment_intent" ADD CONSTRAINT "external_payment_intent_organization_id_requested_by_fkey" FOREIGN KEY ("organization_id", "requested_by") REFERENCES "user_account"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "external_payment_intent" ADD CONSTRAINT "external_payment_intent_organization_id_reservation_id_fkey" FOREIGN KEY ("organization_id", "reservation_id") REFERENCES "reservation"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "external_payment_intent" ADD CONSTRAINT "external_payment_intent_organization_id_account_id_fkey" FOREIGN KEY ("organization_id", "account_id") REFERENCES "ledger_account"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "external_payment_intent" ADD CONSTRAINT "external_payment_intent_organization_id_policy_id_fkey" FOREIGN KEY ("organization_id", "policy_id") REFERENCES "config_rule"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "external_payment_intent" ADD CONSTRAINT "external_payment_intent_currency_fkey" FOREIGN KEY ("currency") REFERENCES "currency"("code") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "external_payment_capture" ADD CONSTRAINT "external_payment_capture_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "external_payment_capture" ADD CONSTRAINT "external_payment_capture_organization_id_intent_id_fkey" FOREIGN KEY ("organization_id", "intent_id") REFERENCES "external_payment_intent"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "external_payment_capture" ADD CONSTRAINT "external_payment_capture_currency_fkey" FOREIGN KEY ("currency") REFERENCES "currency"("code") ON DELETE RESTRICT ON UPDATE NO ACTION;


ALTER TABLE external_payment_intent ADD CONSTRAINT external_payment_intent_money CHECK (amount>0);
ALTER TABLE external_payment_intent ADD CONSTRAINT external_payment_intent_provider CHECK (provider='paypal' AND order_id ~ '^[A-Za-z0-9_-]{1,127}$' AND policy_version>0);
ALTER TABLE external_payment_capture ADD CONSTRAINT external_payment_capture_money CHECK (amount>0);
ALTER TABLE external_payment_capture ADD CONSTRAINT external_payment_capture_provider CHECK (provider='paypal' AND payment_id ~ '^[A-Za-z0-9_-]{1,127}$');

ALTER TABLE external_payment_intent ENABLE ROW LEVEL SECURITY;
ALTER TABLE external_payment_intent FORCE ROW LEVEL SECURITY;
CREATE POLICY external_payment_intent_tenant_isolation ON external_payment_intent
USING (organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid)
WITH CHECK (organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid);
ALTER TABLE external_payment_capture ENABLE ROW LEVEL SECURITY;
ALTER TABLE external_payment_capture FORCE ROW LEVEL SECURITY;
CREATE POLICY external_payment_capture_tenant_isolation ON external_payment_capture
USING (organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid)
WITH CHECK (organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid);

CREATE TRIGGER external_payment_intent_no_update BEFORE UPDATE ON external_payment_intent FOR EACH ROW EXECUTE FUNCTION app_prevent_ledger_mutation();
CREATE TRIGGER external_payment_intent_no_delete BEFORE DELETE ON external_payment_intent FOR EACH ROW EXECUTE FUNCTION app_prevent_ledger_mutation();
CREATE TRIGGER external_payment_capture_no_update BEFORE UPDATE ON external_payment_capture FOR EACH ROW EXECUTE FUNCTION app_prevent_ledger_mutation();
CREATE TRIGGER external_payment_capture_no_delete BEFORE DELETE ON external_payment_capture FOR EACH ROW EXECUTE FUNCTION app_prevent_ledger_mutation();

CREATE FUNCTION app_guard_external_payment_intent() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE command jsonb; policy_method jsonb; expected_audit jsonb;
BEGIN
  command:=NEW.input->'receipt';
  IF NEW.input->>'provider' IS DISTINCT FROM NEW.provider OR NEW.input->>'orderId' IS DISTINCT FROM NEW.order_id
    OR command->>'idempotencyKey' IS DISTINCT FROM NEW.idempotency_key::text
    OR command->>'reservationId' IS DISTINCT FROM NEW.reservation_id::text
    OR command->>'accountId' IS DISTINCT FROM NEW.account_id::text
    OR command->>'externalReference' IS DISTINCT FROM NEW.order_id
    OR command->>'amount' IS DISTINCT FROM NEW.amount::text OR command->>'currency' IS DISTINCT FROM NEW.currency
    OR NEW.authorization_cap->>'organizationId' IS DISTINCT FROM NEW.organization_id::text
    OR NEW.authorization_cap->>'userAccountId' IS DISTINCT FROM NEW.requested_by::text
    OR NEW.authorization_cap->>'schemaVersion' IS DISTINCT FROM '1'
    OR COALESCE(command->>'reviewFingerprint','') !~ '^[a-f0-9]{64}$' OR COALESCE(command->>'paymentMethodFingerprint','') !~ '^[a-f0-9]{64}$'
    OR length(COALESCE(command->>'reason',''))<6 OR length(COALESCE(command->>'purpose',''))<3
    OR NEW.canonical_request::jsonb IS DISTINCT FROM jsonb_build_object('organizationId',NEW.organization_id,'actorId',NEW.requested_by,'input',NEW.input)
    OR NEW.request_fingerprint IS DISTINCT FROM encode(sha256(convert_to(NEW.canonical_request,'UTF8')),'hex')
    OR NEW.source_identity IS DISTINCT FROM encode(sha256(convert_to('{"provider":"paypal","orderId":"'||NEW.order_id||'"}','UTF8')),'hex')
  THEN RAISE EXCEPTION 'original exact external payment intent required'; END IF;
  SELECT method INTO policy_method FROM config_rule r CROSS JOIN LATERAL jsonb_array_elements(r.value->'methods') method
    WHERE r.organization_id=NEW.organization_id AND r.id=NEW.policy_id AND r.version=NEW.policy_version AND r.key='finance.payment_methods'
      AND method->>'key'=command->>'method' AND method->>'adapter'='paypal' AND method->'enabled'='true'::jsonb AND method->'currencies' ? NEW.currency;
  IF policy_method IS NULL THEN RAISE EXCEPTION 'configured original external payment method required'; END IF;
  IF EXISTS(SELECT 1 FROM financial_transaction t WHERE t.organization_id=NEW.organization_id AND t.reference='GUEST_DEPOSIT:'||NEW.idempotency_key::text)
    THEN RAISE EXCEPTION 'an existing financial receipt cannot request another external capture'; END IF;
  expected_audit:=jsonb_build_object('intentId',NEW.id,'sourceIdentity',NEW.source_identity,'requestFingerprint',NEW.request_fingerprint,
    'provider',NEW.provider,'policyId',NEW.policy_id,'policyVersion',NEW.policy_version,'amount',jsonb_build_object('amount',NEW.amount::text,'currency',NEW.currency));
  IF NOT EXISTS(SELECT 1 FROM audit_log a WHERE a.organization_id=NEW.organization_id AND a.actor_id=NEW.requested_by
    AND a.action='finance.external_payment.requested' AND a.resource_type='financial_transaction' AND a.resource_id=NEW.id
    AND a.after=expected_audit AND a.reason=command->>'reason' AND (a.before IS NULL OR a.before='null'::jsonb))
    OR NOT EXISTS(SELECT 1 FROM outbox_event e WHERE e.organization_id=NEW.organization_id AND e.type='ExternalPaymentCaptureRequested'
      AND e.payload=jsonb_build_object('intentId',NEW.id) AND e.idempotency_key='external-payment-intent:'||NEW.id::text||':capture')
  THEN RAISE EXCEPTION 'attributed external intent audit and durable outbox required'; END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION app_guard_external_payment_capture() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE source external_payment_intent%ROWTYPE; expected jsonb;
BEGIN
  SELECT * INTO source FROM external_payment_intent WHERE organization_id=NEW.organization_id AND id=NEW.intent_id;
  IF NOT FOUND OR NEW.provider<>source.provider OR NEW.amount<>source.amount OR NEW.currency<>source.currency
    THEN RAISE EXCEPTION 'original exact provider capture required'; END IF;
  IF EXISTS(SELECT 1 FROM external_payment_intent i WHERE i.organization_id=source.organization_id AND i.id=source.id AND i.xmin::text=pg_current_xact_id()::xid::text)
    THEN RAISE EXCEPTION 'durable prior external intent required before capture'; END IF;
  expected:=jsonb_build_object('schemaVersion',1,'provider',source.provider,'orderId',source.order_id,'paymentId',NEW.payment_id,
    'amount',jsonb_build_object('amount',NEW.amount::text,'currency',NEW.currency));
  IF NEW.evidence IS DISTINCT FROM expected OR NOT EXISTS(SELECT 1 FROM audit_log a WHERE a.organization_id=NEW.organization_id
    AND a.actor_id IS NULL AND a.action='finance.external_payment.captured' AND a.resource_type='financial_transaction' AND a.resource_id=source.id
    AND a.after=jsonb_build_object('intentId',source.id,'captureId',NEW.id,'evidence',expected) AND (a.before IS NULL OR a.before='null'::jsonb))
  THEN RAISE EXCEPTION 'verified provider capture witness and system audit required'; END IF;
  RETURN NEW;
END $$;

CREATE CONSTRAINT TRIGGER external_payment_intent_native_guard AFTER INSERT ON external_payment_intent
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app_guard_external_payment_intent();
CREATE CONSTRAINT TRIGGER external_payment_capture_native_guard AFTER INSERT ON external_payment_capture
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app_guard_external_payment_capture();

CREATE FUNCTION app_require_external_payment_capture() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE source external_payment_intent%ROWTYPE; capture external_payment_capture%ROWTYPE; receipt jsonb;
BEGIN
  IF NOT NEW.sealed OR NEW.reference NOT LIKE 'GUEST_DEPOSIT:%' THEN RETURN NEW; END IF;
  SELECT * INTO source FROM external_payment_intent WHERE organization_id=NEW.organization_id AND idempotency_key::text=substr(NEW.reference,15);
  IF NOT FOUND THEN RETURN NEW; END IF;
  SELECT * INTO capture FROM external_payment_capture WHERE organization_id=source.organization_id AND intent_id=source.id;
  SELECT a.after->'input' INTO receipt FROM audit_log a WHERE a.organization_id=NEW.organization_id AND a.resource_id=NEW.id
    AND a.resource_type='financial_transaction' AND a.action='finance.guest_deposit.received' ORDER BY a.id LIMIT 1;
  IF capture.id IS NULL OR receipt IS NULL OR NEW.created_by IS DISTINCT FROM source.requested_by
    OR receipt->>'reservationId' IS DISTINCT FROM source.reservation_id::text OR receipt->>'accountId' IS DISTINCT FROM source.account_id::text
    OR receipt->>'amount' IS DISTINCT FROM source.amount::text OR receipt->>'currency' IS DISTINCT FROM source.currency
    OR receipt->>'externalReference' IS DISTINCT FROM source.order_id OR receipt->>'method' IS DISTINCT FROM source.input->'receipt'->>'method'
    OR receipt->>'purpose' IS DISTINCT FROM source.input->'receipt'->>'purpose'
  THEN RAISE EXCEPTION 'verified original external capture required before financial admission'; END IF;
  RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER financial_transaction_external_capture_guard AFTER INSERT OR UPDATE ON financial_transaction
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app_require_external_payment_capture();

COMMIT;
