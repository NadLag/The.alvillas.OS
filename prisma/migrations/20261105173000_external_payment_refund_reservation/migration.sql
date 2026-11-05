BEGIN;

-- CreateTable
CREATE TABLE "external_payment_refund_intent" (
    "id" UUID NOT NULL DEFAULT app_uuid_v7(),
    "organization_id" UUID NOT NULL,
    "capture_id" UUID NOT NULL,
    "deposit_id" UUID NOT NULL,
    "requested_by" UUID NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "idempotency_key" UUID NOT NULL,
    "request_fingerprint" CHAR(64) NOT NULL,
    "canonical_request" TEXT NOT NULL,
    "input" JSONB NOT NULL,
    "authorization_cap" JSONB NOT NULL,
    "requested_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "external_payment_refund_intent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "external_payment_refund_attempt" (
    "id" UUID NOT NULL DEFAULT app_uuid_v7(),
    "organization_id" UUID NOT NULL,
    "intent_id" UUID NOT NULL,
    "started_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "external_payment_refund_attempt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "external_payment_refund_identity" (
    "id" UUID NOT NULL DEFAULT app_uuid_v7(),
    "organization_id" UUID NOT NULL,
    "intent_id" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "refund_id" TEXT NOT NULL,
    "retained_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "external_payment_refund_identity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "external_payment_refund_evidence" (
    "id" UUID NOT NULL DEFAULT app_uuid_v7(),
    "organization_id" UUID NOT NULL,
    "identity_id" UUID NOT NULL,
    "state" TEXT NOT NULL,
    "provider_created_at" TIMESTAMPTZ(6) NOT NULL,
    "provider_updated_at" TIMESTAMPTZ(6) NOT NULL,
    "refunded_at" TIMESTAMPTZ(6),
    "evidence" JSONB NOT NULL,
    "observed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "external_payment_refund_evidence_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "external_payment_refund_intent_deposit_idx" ON "external_payment_refund_intent"("organization_id", "deposit_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "external_payment_refund_intent_org_id_unique" ON "external_payment_refund_intent"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "external_payment_refund_intent_key_unique" ON "external_payment_refund_intent"("organization_id", "idempotency_key");

-- CreateIndex
CREATE UNIQUE INDEX "external_payment_refund_attempt_org_id_unique" ON "external_payment_refund_attempt"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "external_payment_refund_attempt_intent_unique" ON "external_payment_refund_attempt"("organization_id", "intent_id");

-- CreateIndex
CREATE UNIQUE INDEX "external_payment_refund_identity_org_id_unique" ON "external_payment_refund_identity"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "external_payment_refund_identity_intent_unique" ON "external_payment_refund_identity"("organization_id", "intent_id");

-- CreateIndex
CREATE UNIQUE INDEX "external_payment_refund_identity_provider_unique" ON "external_payment_refund_identity"("provider", "refund_id");

-- CreateIndex
CREATE UNIQUE INDEX "external_payment_refund_evidence_org_id_unique" ON "external_payment_refund_evidence"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "external_payment_refund_evidence_version_unique" ON "external_payment_refund_evidence"("organization_id", "identity_id", "provider_updated_at", "state");

-- AddForeignKey
ALTER TABLE "external_payment_refund_intent" ADD CONSTRAINT "external_payment_refund_intent_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "external_payment_refund_intent" ADD CONSTRAINT "external_payment_refund_intent_organization_id_capture_id_fkey" FOREIGN KEY ("organization_id", "capture_id") REFERENCES "external_payment_capture"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "external_payment_refund_intent" ADD CONSTRAINT "external_payment_refund_intent_organization_id_deposit_id_fkey" FOREIGN KEY ("organization_id", "deposit_id") REFERENCES "external_payment_intent"("organization_id", "idempotency_key") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "external_payment_refund_intent" ADD CONSTRAINT "external_payment_refund_intent_organization_id_requested_b_fkey" FOREIGN KEY ("organization_id", "requested_by") REFERENCES "user_account"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "external_payment_refund_intent" ADD CONSTRAINT "external_payment_refund_intent_currency_fkey" FOREIGN KEY ("currency") REFERENCES "currency"("code") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "external_payment_refund_attempt" ADD CONSTRAINT "external_payment_refund_attempt_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "external_payment_refund_attempt" ADD CONSTRAINT "external_payment_refund_attempt_organization_id_intent_id_fkey" FOREIGN KEY ("organization_id", "intent_id") REFERENCES "external_payment_refund_intent"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "external_payment_refund_identity" ADD CONSTRAINT "external_payment_refund_identity_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "external_payment_refund_identity" ADD CONSTRAINT "external_payment_refund_identity_organization_id_intent_id_fkey" FOREIGN KEY ("organization_id", "intent_id") REFERENCES "external_payment_refund_intent"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "external_payment_refund_evidence" ADD CONSTRAINT "external_payment_refund_evidence_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "external_payment_refund_evidence" ADD CONSTRAINT "external_payment_refund_evidence_organization_id_identity__fkey" FOREIGN KEY ("organization_id", "identity_id") REFERENCES "external_payment_refund_identity"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['external_payment_refund_intent','external_payment_refund_attempt','external_payment_refund_identity','external_payment_refund_evidence'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',table_name);
    EXECUTE format('CREATE POLICY %I ON %I USING(organization_id=NULLIF(current_setting(''app.current_organization_id'',true),'''')::uuid) WITH CHECK(organization_id=NULLIF(current_setting(''app.current_organization_id'',true),'''')::uuid)',table_name||'_tenant_isolation',table_name);
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION app_prevent_ledger_mutation()',table_name||'_no_update',table_name);
    EXECUTE format('CREATE TRIGGER %I BEFORE DELETE ON %I FOR EACH ROW EXECUTE FUNCTION app_prevent_ledger_mutation()',table_name||'_no_delete',table_name);
  END LOOP;
END $$;

ALTER TABLE external_payment_refund_intent ADD CONSTRAINT external_payment_refund_amount_positive CHECK(amount>0 AND amount<>'NaN'::numeric);
ALTER TABLE external_payment_refund_identity ADD CONSTRAINT external_payment_refund_provider_valid CHECK(provider='paypal' AND refund_id ~ '^[A-Za-z0-9_-]{1,127}$');
ALTER TABLE external_payment_refund_evidence ADD CONSTRAINT external_payment_refund_evidence_status_valid CHECK(state IN('PENDING','COMPLETED','FAILED','CANCELLED') AND provider_updated_at>=provider_created_at AND ((state='COMPLETED' AND refunded_at=provider_updated_at) OR (state<>'COMPLETED' AND refunded_at IS NULL)));

-- These are reservations of existing funds, never another balance or monetary posting.
-- An unknown, pending or failed provider result retains its reservation until an explicit safe release.
CREATE FUNCTION app_external_refund_reserved(tenant uuid,deposit uuid) RETURNS numeric
LANGUAGE sql STABLE SET search_path=public,pg_temp AS $$
 SELECT coalesce(sum(r.amount),0) FROM external_payment_refund_intent r
 WHERE r.organization_id=tenant AND r.deposit_id=deposit AND NOT EXISTS(
   SELECT 1 FROM financial_transaction t WHERE t.organization_id=r.organization_id
   AND t.idempotency_key='guest-deposit:'||r.idempotency_key::text AND t.reference='GUEST_DEPOSIT_REFUND:'||r.idempotency_key::text AND t.sealed)
$$;

CREATE FUNCTION app_assert_external_refund_budget(tenant uuid,deposit uuid) RETURNS void
LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE original guest_payment_receipt%ROWTYPE; remaining numeric; reserved numeric;
BEGIN
  IF NOT EXISTS(SELECT 1 FROM external_payment_refund_intent WHERE organization_id=tenant AND deposit_id=deposit) THEN RETURN; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(tenant::text||':financial-transfer:guest-deposit-source:'||deposit::text,0));
  SELECT * INTO original FROM guest_payment_receipt WHERE organization_id=tenant AND deposit_id=deposit;
  IF NOT FOUND THEN RAISE EXCEPTION 'original admitted guest funds required for external refund'; END IF;
  SELECT coalesce(sum(CASE p.side WHEN 'CREDIT' THEN p.amount ELSE -p.amount END),0) INTO remaining FROM posting p
  WHERE p.organization_id=tenant AND p.ledger_account_id=original.liability_account_id AND p.currency=original.currency
    AND p.dimensions->>'source'='GUEST_DEPOSIT' AND p.dimensions->>'deposit_id'=deposit::text;
  reserved:=app_external_refund_reserved(tenant,deposit);
  IF remaining<reserved THEN RAISE EXCEPTION 'original guest funds are reserved for external refunds'; END IF;
END $$;

CREATE FUNCTION app_guard_external_refund_intent() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE source external_payment_intent%ROWTYPE; captured external_payment_capture%ROWTYPE; command jsonb; expected jsonb;
BEGIN
  SELECT * INTO captured FROM external_payment_capture WHERE organization_id=NEW.organization_id AND id=NEW.capture_id;
  SELECT * INTO source FROM external_payment_intent WHERE organization_id=NEW.organization_id AND id=captured.intent_id;
  command:=NEW.input->'refund';
  IF captured.id IS NULL OR source.id IS NULL OR source.idempotency_key<>NEW.deposit_id OR captured.currency<>NEW.currency OR NEW.amount>captured.amount
    OR NEW.input->>'captureId' IS DISTINCT FROM NEW.capture_id::text OR command->>'depositId' IS DISTINCT FROM NEW.deposit_id::text
    OR command->>'idempotencyKey' IS DISTINCT FROM NEW.idempotency_key::text OR command->>'amount' IS DISTINCT FROM NEW.amount::text
    OR command->>'currency' IS DISTINCT FROM NEW.currency OR command->>'accountId' IS DISTINCT FROM source.account_id::text
    OR command->>'method' IS DISTINCT FROM source.input->'receipt'->>'method' OR command->'externalReference' IS DISTINCT FROM 'null'::jsonb
    OR coalesce(command->>'reviewFingerprint','') !~ '^[a-f0-9]{64}$' OR length(coalesce(command->>'purpose',''))<3 OR length(coalesce(command->>'reason',''))<6
    OR NEW.authorization_cap->>'schemaVersion' IS DISTINCT FROM '1' OR NEW.authorization_cap->>'organizationId' IS DISTINCT FROM NEW.organization_id::text
    OR NEW.authorization_cap->>'userAccountId' IS DISTINCT FROM NEW.requested_by::text
    OR NEW.canonical_request::jsonb IS DISTINCT FROM jsonb_build_object('organizationId',NEW.organization_id,'actorId',NEW.requested_by,'input',NEW.input)
    OR NEW.request_fingerprint IS DISTINCT FROM encode(sha256(convert_to(NEW.canonical_request,'UTF8')),'hex')
    OR NOT EXISTS(SELECT 1 FROM guest_payment_receipt p JOIN financial_transaction t ON t.organization_id=p.organization_id AND t.id=p.transaction_id
      WHERE p.organization_id=NEW.organization_id AND p.deposit_id=NEW.deposit_id AND p.account_id=source.account_id AND p.amount=captured.amount AND p.currency=NEW.currency AND t.sealed)
    OR EXISTS(SELECT 1 FROM financial_transaction t WHERE t.organization_id=NEW.organization_id AND t.idempotency_key='guest-deposit:'||NEW.idempotency_key::text)
  THEN RAISE EXCEPTION 'exact original admitted provider refund intent required'; END IF;
  expected:=jsonb_build_object('intentId',NEW.id,'captureId',NEW.capture_id,'depositId',NEW.deposit_id,'requestFingerprint',NEW.request_fingerprint,'amount',jsonb_build_object('amount',NEW.amount::text,'currency',NEW.currency));
  IF NOT EXISTS(SELECT 1 FROM audit_log a WHERE a.organization_id=NEW.organization_id AND a.actor_id=NEW.requested_by AND a.action='finance.external_payment.refund_requested'
    AND a.resource_type='financial_transaction' AND a.resource_id=NEW.id AND a.after=expected AND a.reason=command->>'reason' AND a.xmin::text=pg_current_xact_id()::xid::text)
    OR NOT EXISTS(SELECT 1 FROM outbox_event e WHERE e.organization_id=NEW.organization_id AND e.type='ExternalPaymentRefundRequested'
      AND e.payload=jsonb_build_object('intentId',NEW.id) AND e.idempotency_key='external-payment-refund:'||NEW.id::text||':request')
  THEN RAISE EXCEPTION 'original refund reservation audit and durable outbox required'; END IF;
  PERFORM app_assert_external_refund_budget(NEW.organization_id,NEW.deposit_id);
  RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER external_payment_refund_intent_native_guard AFTER INSERT ON external_payment_refund_intent DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app_guard_external_refund_intent();

CREATE FUNCTION app_guard_external_refund_attempt() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE source external_payment_refund_intent%ROWTYPE;
BEGIN
  SELECT * INTO source FROM external_payment_refund_intent WHERE organization_id=NEW.organization_id AND id=NEW.intent_id;
  IF NOT FOUND OR EXISTS(SELECT 1 FROM external_payment_refund_intent r WHERE r.organization_id=NEW.organization_id AND r.id=NEW.intent_id AND r.xmin::text=pg_current_xact_id()::xid::text) THEN RAISE EXCEPTION 'committed original refund reservation required before provider attempt'; END IF;
  IF NOT EXISTS(SELECT 1 FROM audit_log a WHERE a.organization_id=NEW.organization_id AND a.actor_id IS NULL AND a.action='finance.external_payment.refund_started'
    AND a.resource_type='financial_transaction' AND a.resource_id=source.id AND a.after=jsonb_build_object('intentId',source.id,'attemptId',NEW.id) AND a.xmin::text=pg_current_xact_id()::xid::text)
  THEN RAISE EXCEPTION 'attributed original refund attempt audit required'; END IF;
  PERFORM app_assert_external_refund_budget(NEW.organization_id,source.deposit_id);
  RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER external_payment_refund_attempt_native_guard AFTER INSERT ON external_payment_refund_attempt DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app_guard_external_refund_attempt();

CREATE FUNCTION app_guard_external_refund_identity() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM external_payment_refund_attempt a WHERE a.organization_id=NEW.organization_id AND a.intent_id=NEW.intent_id AND a.xmin::text<>pg_current_xact_id()::xid::text)
    OR NOT EXISTS(SELECT 1 FROM external_payment_refund_evidence e WHERE e.organization_id=NEW.organization_id AND e.identity_id=NEW.id AND e.xmin::text=pg_current_xact_id()::xid::text)
  THEN RAISE EXCEPTION 'prior committed refund attempt and actual provider identity evidence required'; END IF;
  RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER external_payment_refund_identity_native_guard AFTER INSERT ON external_payment_refund_identity DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app_guard_external_refund_identity();

CREATE FUNCTION app_guard_external_refund_evidence() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE identity external_payment_refund_identity%ROWTYPE; source external_payment_refund_intent%ROWTYPE; captured external_payment_capture%ROWTYPE; expected jsonb;
BEGIN
  SELECT * INTO identity FROM external_payment_refund_identity WHERE organization_id=NEW.organization_id AND id=NEW.identity_id;
  SELECT * INTO source FROM external_payment_refund_intent WHERE organization_id=NEW.organization_id AND id=identity.intent_id;
  SELECT * INTO captured FROM external_payment_capture WHERE organization_id=NEW.organization_id AND id=source.capture_id;
  expected:=jsonb_build_object('refundId',identity.refund_id,'captureId',captured.payment_id,'requestId',source.idempotency_key,
    'amount',jsonb_build_object('amount',source.amount::text,'currency',source.currency),'state',NEW.state,
    'createdAt',NEW.evidence->'createdAt','updatedAt',NEW.evidence->'updatedAt','refundedAt',NEW.evidence->'refundedAt');
  IF identity.id IS NULL OR source.id IS NULL OR captured.id IS NULL OR NEW.evidence IS DISTINCT FROM expected
    OR (NEW.evidence->>'createdAt')::timestamptz IS DISTINCT FROM NEW.provider_created_at OR (NEW.evidence->>'updatedAt')::timestamptz IS DISTINCT FROM NEW.provider_updated_at
    OR (NEW.evidence->>'refundedAt')::timestamptz IS DISTINCT FROM NEW.refunded_at OR NEW.provider_created_at<captured.captured_at
    OR NOT EXISTS(SELECT 1 FROM audit_log a WHERE a.organization_id=NEW.organization_id AND a.actor_id IS NULL AND a.action='finance.external_payment.refund_observed'
      AND a.resource_type='financial_transaction' AND a.resource_id=source.id AND a.after=jsonb_build_object('intentId',source.id,'identityId',identity.id,'evidenceId',NEW.id,'evidence',NEW.evidence) AND a.xmin::text=pg_current_xact_id()::xid::text)
  THEN RAISE EXCEPTION 'exact original refund evidence and attributed system audit required'; END IF;
  RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER external_payment_refund_evidence_native_guard AFTER INSERT ON external_payment_refund_evidence DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app_guard_external_refund_evidence();

CREATE FUNCTION app_guard_external_refund_claim_posting() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
  IF NEW.dimensions->>'source'='GUEST_DEPOSIT' AND coalesce(NEW.dimensions->>'deposit_id','') ~* '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'
  THEN PERFORM app_assert_external_refund_budget(NEW.organization_id,(NEW.dimensions->>'deposit_id')::uuid); END IF;
  RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER posting_external_refund_reservation_guard AFTER INSERT ON posting DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app_guard_external_refund_claim_posting();

CREATE FUNCTION app_guard_external_refund_admission() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE source external_payment_refund_intent%ROWTYPE; actual record; saved jsonb;
BEGIN
  IF NEW.reverses_transaction_id IS NOT NULL AND EXISTS(SELECT 1 FROM financial_transaction t JOIN external_payment_refund_intent r ON r.organization_id=t.organization_id
    AND t.idempotency_key='guest-deposit:'||r.idempotency_key::text WHERE t.organization_id=NEW.organization_id AND t.id=NEW.reverses_transaction_id)
  THEN RAISE EXCEPTION 'verified provider refunds require attributed actual corrective money movements'; END IF;
  IF NOT NEW.sealed THEN RETURN NEW; END IF;
  SELECT a.after INTO saved FROM audit_log a WHERE a.organization_id=NEW.organization_id AND a.resource_type='financial_transaction' AND a.resource_id=NEW.id AND a.action='finance.guest_deposit.refunded';
  SELECT * INTO source FROM external_payment_refund_intent WHERE organization_id=NEW.organization_id AND 'guest-deposit:'||idempotency_key::text=NEW.idempotency_key;
  IF NOT FOUND THEN
    IF EXISTS(SELECT 1 FROM external_payment_capture c JOIN external_payment_intent i ON i.organization_id=c.organization_id AND i.id=c.intent_id
      WHERE i.organization_id=NEW.organization_id AND i.idempotency_key::text=saved->'input'->>'depositId' AND i.account_id::text=saved->'input'->>'accountId')
    THEN RAISE EXCEPTION 'actual provider merchant refund requires verified durable source'; END IF;
    RETURN NEW;
  END IF;
  SELECT e.*,i.refund_id INTO actual FROM external_payment_refund_identity i JOIN external_payment_refund_evidence e ON e.organization_id=i.organization_id AND e.identity_id=i.id
    WHERE i.organization_id=source.organization_id AND i.intent_id=source.id AND e.state='COMPLETED' AND e.xmin::text<>pg_current_xact_id()::xid::text ORDER BY e.provider_updated_at,e.id LIMIT 1;
  IF actual.id IS NULL OR NEW.created_by IS DISTINCT FROM source.requested_by OR NEW.occurred_at IS DISTINCT FROM actual.refunded_at
    OR NEW.reference IS DISTINCT FROM 'GUEST_DEPOSIT_REFUND:'||source.idempotency_key::text
    OR saved->'input'->>'externalReference' IS DISTINCT FROM actual.refund_id
    OR (saved->'input'-'reviewFingerprint'-'externalReference') IS DISTINCT FROM (source.input->'refund'-'reviewFingerprint'-'externalReference')
  THEN RAISE EXCEPTION 'committed verified provider refund required for original native admission'; END IF;
  RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER financial_transaction_external_refund_guard AFTER INSERT OR UPDATE ON financial_transaction DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app_guard_external_refund_admission();

COMMIT;


