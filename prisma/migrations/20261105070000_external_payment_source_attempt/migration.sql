BEGIN;

-- AlterTable
ALTER TABLE "external_payment_intent" ADD COLUMN     "source_snapshot" JSONB;

-- CreateTable
CREATE TABLE "external_payment_attempt" (
    "id" UUID NOT NULL DEFAULT app_uuid_v7(),
    "organization_id" UUID NOT NULL,
    "intent_id" UUID NOT NULL,
    "started_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "external_payment_attempt_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "external_payment_attempt_org_id_unique" ON "external_payment_attempt"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "external_payment_attempt_intent_unique" ON "external_payment_attempt"("organization_id", "intent_id");

-- AddForeignKey
ALTER TABLE "external_payment_attempt" ADD CONSTRAINT "external_payment_attempt_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "external_payment_attempt" ADD CONSTRAINT "external_payment_attempt_organization_id_intent_id_fkey" FOREIGN KEY ("organization_id", "intent_id") REFERENCES "external_payment_intent"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;


ALTER TABLE external_payment_attempt ENABLE ROW LEVEL SECURITY;
ALTER TABLE external_payment_attempt FORCE ROW LEVEL SECURITY;
CREATE POLICY external_payment_attempt_tenant_isolation ON external_payment_attempt
USING(organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid)
WITH CHECK(organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid);
CREATE TRIGGER external_payment_attempt_no_update BEFORE UPDATE ON external_payment_attempt FOR EACH ROW EXECUTE FUNCTION app_prevent_ledger_mutation();
CREATE TRIGGER external_payment_attempt_no_delete BEFORE DELETE ON external_payment_attempt FOR EACH ROW EXECUTE FUNCTION app_prevent_ledger_mutation();

CREATE FUNCTION app_guard_external_payment_source() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE expected jsonb;
BEGIN
  SELECT jsonb_build_object('schemaVersion',1,'organizationId',NEW.organization_id,'userAccountId',u.id,'personId',u.person_id,
    'reservationId',r.id,'propertyId',r.property_id,'guestId',r.guest_id,'bookingSource',r.source,
    'financialSnapshotId',s.id,'financialSnapshotVersion',s.version,'city',COALESCE(p.city_id::text,p.city),'region',COALESCE(p.region_id::text,p.region),
    'accountId',NEW.account_id,'amount',jsonb_build_object('amount',NEW.amount::text,'currency',NEW.currency),'receivedAt',NEW.input->'receipt'->>'receivedAt') INTO expected
  FROM reservation r JOIN property p ON p.organization_id=r.organization_id AND p.id=r.property_id
    JOIN user_account u ON u.organization_id=r.organization_id AND u.id=NEW.requested_by
    JOIN LATERAL (SELECT id,version FROM reservation_financial_snapshot WHERE organization_id=r.organization_id AND reservation_id=r.id ORDER BY version DESC LIMIT 1) s ON true
  WHERE r.organization_id=NEW.organization_id AND r.id=NEW.reservation_id AND r.guest_id IS NOT NULL;
  IF expected IS NULL OR NEW.source_snapshot IS DISTINCT FROM expected OR NEW.source_snapshot->>'personId' IS DISTINCT FROM NEW.authorization_cap->>'personId'
    THEN RAISE EXCEPTION 'complete original external payment source snapshot required'; END IF;
  RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER external_payment_source_native_guard AFTER INSERT ON external_payment_intent
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app_guard_external_payment_source();

CREATE FUNCTION app_guard_external_payment_attempt() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE source external_payment_intent%ROWTYPE;
BEGIN
  SELECT * INTO source FROM external_payment_intent WHERE organization_id=NEW.organization_id AND id=NEW.intent_id;
  IF NOT FOUND OR source.source_snapshot IS NULL OR EXISTS(SELECT 1 FROM external_payment_intent i WHERE i.organization_id=source.organization_id AND i.id=source.id AND i.xmin::text=pg_current_xact_id()::xid::text)
    THEN RAISE EXCEPTION 'durable original external source required before provider attempt'; END IF;
  IF NOT EXISTS(SELECT 1 FROM audit_log a WHERE a.organization_id=NEW.organization_id AND a.actor_id IS NULL
    AND a.action='finance.external_payment.capture_started' AND a.resource_type='financial_transaction' AND a.resource_id=source.id
    AND a.after=jsonb_build_object('intentId',source.id,'attemptId',NEW.id) AND (a.before IS NULL OR a.before='null'::jsonb))
    THEN RAISE EXCEPTION 'attributed original provider attempt audit required'; END IF;
  RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER external_payment_attempt_native_guard AFTER INSERT ON external_payment_attempt
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app_guard_external_payment_attempt();

CREATE FUNCTION app_require_prior_external_payment_attempt() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM external_payment_attempt a WHERE a.organization_id=NEW.organization_id AND a.intent_id=NEW.intent_id AND a.xmin::text<>pg_current_xact_id()::xid::text)
    THEN RAISE EXCEPTION 'durable prior provider attempt required before capture evidence'; END IF;
  RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER external_payment_capture_attempt_guard AFTER INSERT ON external_payment_capture
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app_require_prior_external_payment_attempt();

CREATE FUNCTION app_require_external_payment_source() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE source external_payment_intent%ROWTYPE;
BEGIN
  IF NOT NEW.sealed OR NEW.reference NOT LIKE 'GUEST_DEPOSIT:%' THEN RETURN NEW; END IF;
  SELECT * INTO source FROM external_payment_intent WHERE organization_id=NEW.organization_id AND idempotency_key::text=substr(NEW.reference,15);
  IF NOT FOUND THEN RETURN NEW; END IF;
  IF source.source_snapshot IS NULL OR NOT EXISTS(SELECT 1 FROM guest_payment_receipt p WHERE p.organization_id=NEW.organization_id AND p.transaction_id=NEW.id
    AND p.reservation_id=source.reservation_id AND p.property_id::text=source.source_snapshot->>'propertyId' AND p.guest_id::text=source.source_snapshot->>'guestId'
    AND p.financial_snapshot_id::text=source.source_snapshot->>'financialSnapshotId')
    THEN RAISE EXCEPTION 'original external receipt source provenance required'; END IF;
  RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER financial_transaction_external_source_guard AFTER INSERT OR UPDATE ON financial_transaction
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app_require_external_payment_source();

COMMIT;
