BEGIN;
-- CreateTable
CREATE TABLE "supplier_invoice_recognition_request" (
    "id" UUID NOT NULL DEFAULT app_uuid_v7(),
    "organization_id" UUID NOT NULL,
    "invoice_id" UUID NOT NULL,
    "submission_id" UUID NOT NULL,
    "invoice_version" INTEGER NOT NULL,
    "current_period" BOOLEAN NOT NULL DEFAULT false,
    "idempotency_key" UUID NOT NULL,
    "request_fingerprint" TEXT NOT NULL,
    "reason" VARCHAR(500) NOT NULL,
    "authorization_cap" JSONB NOT NULL,
    "requested_by" UUID NOT NULL,
    "requested_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "supplier_invoice_recognition_request_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "supplier_invoice_recognition_outcome" (
    "id" UUID NOT NULL DEFAULT app_uuid_v7(),
    "organization_id" UUID NOT NULL,
    "request_id" UUID NOT NULL,
    "state" TEXT NOT NULL,
    "recognition_id" UUID,
    "failure_code" TEXT,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "supplier_invoice_recognition_outcome_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "supplier_invoice_recognition_request_organization_id_invoic_idx" ON "supplier_invoice_recognition_request"("organization_id", "invoice_id", "requested_at", "id");

-- CreateIndex
CREATE INDEX "supplier_invoice_recognition_request_organization_id_reques_idx" ON "supplier_invoice_recognition_request"("organization_id", "requested_by", "requested_at", "id");

-- CreateIndex
CREATE UNIQUE INDEX "supplier_invoice_recognition_request_organization_id_id_key" ON "supplier_invoice_recognition_request"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "supplier_invoice_recognition_request_organization_id_idempo_key" ON "supplier_invoice_recognition_request"("organization_id", "idempotency_key");

-- CreateIndex
CREATE INDEX "supplier_invoice_recognition_outcome_organization_id_occurr_idx" ON "supplier_invoice_recognition_outcome"("organization_id", "occurred_at", "id");

-- CreateIndex
CREATE INDEX "supplier_invoice_recognition_outcome_organization_id_recogn_idx" ON "supplier_invoice_recognition_outcome"("organization_id", "recognition_id");

-- CreateIndex
CREATE UNIQUE INDEX "supplier_invoice_recognition_outcome_organization_id_id_key" ON "supplier_invoice_recognition_outcome"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "supplier_invoice_recognition_outcome_organization_id_reques_key" ON "supplier_invoice_recognition_outcome"("organization_id", "request_id");

-- AddForeignKey
ALTER TABLE "supplier_invoice_recognition_request" ADD CONSTRAINT "supplier_invoice_recognition_request_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "supplier_invoice_recognition_request" ADD CONSTRAINT "supplier_invoice_recognition_request_organization_id_invoi_fkey" FOREIGN KEY ("organization_id", "invoice_id") REFERENCES "supplier_invoice"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "supplier_invoice_recognition_request" ADD CONSTRAINT "supplier_invoice_recognition_request_organization_id_submi_fkey" FOREIGN KEY ("organization_id", "submission_id") REFERENCES "supplier_invoice_submission"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "supplier_invoice_recognition_request" ADD CONSTRAINT "supplier_invoice_recognition_request_organization_id_reque_fkey" FOREIGN KEY ("organization_id", "requested_by") REFERENCES "user_account"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "supplier_invoice_recognition_outcome" ADD CONSTRAINT "supplier_invoice_recognition_outcome_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "supplier_invoice_recognition_outcome" ADD CONSTRAINT "supplier_invoice_recognition_outcome_organization_id_reque_fkey" FOREIGN KEY ("organization_id", "request_id") REFERENCES "supplier_invoice_recognition_request"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "supplier_invoice_recognition_outcome" ADD CONSTRAINT "supplier_invoice_recognition_outcome_organization_id_recog_fkey" FOREIGN KEY ("organization_id", "recognition_id") REFERENCES "supplier_invoice_recognition"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;


ALTER TABLE supplier_invoice_recognition_request ENABLE ROW LEVEL SECURITY;
ALTER TABLE supplier_invoice_recognition_request FORCE ROW LEVEL SECURITY;
CREATE POLICY supplier_invoice_recognition_request_tenant_isolation ON supplier_invoice_recognition_request
 USING (organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid)
 WITH CHECK (organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid);
ALTER TABLE supplier_invoice_recognition_outcome ENABLE ROW LEVEL SECURITY;
ALTER TABLE supplier_invoice_recognition_outcome FORCE ROW LEVEL SECURITY;
CREATE POLICY supplier_invoice_recognition_outcome_tenant_isolation ON supplier_invoice_recognition_outcome
 USING (organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid)
 WITH CHECK (organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid);
CREATE TRIGGER supplier_invoice_recognition_request_immutable BEFORE UPDATE OR DELETE ON supplier_invoice_recognition_request
 FOR EACH ROW EXECUTE FUNCTION app_prevent_ledger_mutation();
CREATE TRIGGER supplier_invoice_recognition_outcome_immutable BEFORE UPDATE OR DELETE ON supplier_invoice_recognition_outcome
 FOR EACH ROW EXECUTE FUNCTION app_prevent_ledger_mutation();
ALTER TABLE supplier_invoice_recognition_request ADD CONSTRAINT supplier_invoice_recognition_request_fields CHECK
 (invoice_version>0 AND length(btrim(reason)) BETWEEN 6 AND 500 AND request_fingerprint ~ '^[0-9a-f]{64}$'
 AND (jsonb_typeof(authorization_cap)='object' AND authorization_cap->>'schemaVersion'='1'
 AND authorization_cap->>'organizationId'=organization_id::text AND authorization_cap->>'userAccountId'=requested_by::text
 AND jsonb_typeof(authorization_cap->'permissions')='array' AND jsonb_typeof(authorization_cap->'scopes')='array') IS TRUE);
ALTER TABLE supplier_invoice_recognition_outcome ADD CONSTRAINT supplier_invoice_recognition_outcome_fields CHECK
 (((state='SUCCEEDED' AND recognition_id IS NOT NULL AND failure_code IS NULL)
 OR (state='DENIED' AND recognition_id IS NULL AND failure_code='ACCESS_DENIED')
 OR (state='CONFLICT' AND recognition_id IS NULL AND failure_code IN ('SOURCE_CHANGED','PERIOD_CLOSED','POLICY_UNAVAILABLE'))
 OR (state='FAILED' AND recognition_id IS NULL AND failure_code='EXECUTION_UNAVAILABLE')) IS TRUE);

CREATE FUNCTION app_supplier_invoice_recognition_request_admission() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE i supplier_invoice%ROWTYPE; s supplier_invoice_submission%ROWTYPE;
BEGIN
 SELECT * INTO i FROM supplier_invoice WHERE organization_id=NEW.organization_id AND id=NEW.invoice_id;
 SELECT * INTO s FROM supplier_invoice_submission WHERE organization_id=NEW.organization_id AND id=NEW.submission_id;
 IF i.id IS NULL OR s.id IS NULL OR i.state<>'APPROVED' OR i.archived_at IS NOT NULL OR i.version<>NEW.invoice_version
  OR i.current_submission_id IS DISTINCT FROM s.id OR s.invoice_id<>i.id OR i.current_revision_id IS DISTINCT FROM s.revision_id
  OR EXISTS(SELECT 1 FROM supplier v WHERE v.organization_id=i.organization_id AND v.id=i.supplier_id AND v.archived_at IS NOT NULL)
  OR (jsonb_array_length(s.snapshot->'stages')>0 AND NOT EXISTS(SELECT 1 FROM approval_request a
    WHERE a.organization_id=i.organization_id AND a.invoice_submission_id=s.id AND a.state='APPROVED'
      AND NOT EXISTS(SELECT 1 FROM approval_stage p WHERE p.organization_id=a.organization_id AND p.approval_id=a.id AND p.state<>'APPROVED')))
 THEN RAISE EXCEPTION 'recognition request requires its actual current approved invoice and review source'; END IF;
 NEW.requested_at=clock_timestamp(); RETURN NEW;
END $$;
CREATE TRIGGER supplier_invoice_recognition_request_admission BEFORE INSERT ON supplier_invoice_recognition_request
 FOR EACH ROW EXECUTE FUNCTION app_supplier_invoice_recognition_request_admission();

CREATE FUNCTION app_supplier_invoice_recognition_request_complete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM audit_log a WHERE a.organization_id=NEW.organization_id AND a.actor_id=NEW.requested_by
   AND a.action='finance.supplier_invoice.recognition_requested' AND a.resource_type='supplier_invoice' AND a.resource_id=NEW.invoice_id
   AND a.reason=NEW.reason AND a.after->>'recognitionRequestId'=NEW.id::text AND a.after->>'submissionId'=NEW.submission_id::text)
 THEN RAISE EXCEPTION 'recognition request requires its attributed atomic audit'; END IF;
 IF NOT EXISTS(SELECT 1 FROM outbox_event e WHERE e.organization_id=NEW.organization_id AND e.type='SupplierInvoiceRecognitionRequested'
   AND e.idempotency_key='supplier-invoice-recognition:'||NEW.id::text||':requested'
   AND e.payload=jsonb_build_object('requestId',NEW.id::text) AND e.occurred_at=date_trunc('milliseconds',NEW.requested_at))
 THEN RAISE EXCEPTION 'recognition request requires its canonical opaque dispatch event'; END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER supplier_invoice_recognition_request_complete AFTER INSERT ON supplier_invoice_recognition_request
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app_supplier_invoice_recognition_request_complete();

CREATE FUNCTION app_supplier_invoice_recognition_outcome_admission() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE q supplier_invoice_recognition_request%ROWTYPE; r supplier_invoice_recognition%ROWTYPE;
BEGIN
 SELECT * INTO q FROM supplier_invoice_recognition_request WHERE organization_id=NEW.organization_id AND id=NEW.request_id;
 IF q.id IS NULL THEN RAISE EXCEPTION 'recognition outcome requires its actual request'; END IF;
 SELECT * INTO r FROM supplier_invoice_recognition WHERE organization_id=q.organization_id AND idempotency_key=q.idempotency_key;
 IF NEW.state='SUCCEEDED' THEN
  IF r.id IS NULL OR r.id IS DISTINCT FROM NEW.recognition_id OR r.invoice_id<>q.invoice_id OR r.submission_id<>q.submission_id
    OR r.invoice_version<>q.invoice_version OR r.current_period<>q.current_period OR r.created_by<>q.requested_by
    OR r.request_fingerprint<>q.request_fingerprint OR r.reason<>q.reason
  THEN RAISE EXCEPTION 'successful recognition outcome must identify the exact committed financial source'; END IF;
 ELSIF r.id IS NOT NULL AND r.request_fingerprint=q.request_fingerprint AND r.created_by=q.requested_by THEN
  RAISE EXCEPTION 'a committed recognition cannot receive a failure outcome';
 END IF;
 NEW.occurred_at=clock_timestamp(); RETURN NEW;
END $$;
CREATE TRIGGER supplier_invoice_recognition_outcome_admission BEFORE INSERT ON supplier_invoice_recognition_outcome
 FOR EACH ROW EXECUTE FUNCTION app_supplier_invoice_recognition_outcome_admission();

CREATE FUNCTION app_supplier_invoice_recognition_outcome_complete() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE q supplier_invoice_recognition_request%ROWTYPE;
BEGIN
 SELECT * INTO q FROM supplier_invoice_recognition_request WHERE organization_id=NEW.organization_id AND id=NEW.request_id;
 IF NOT EXISTS(SELECT 1 FROM audit_log a WHERE a.organization_id=q.organization_id AND a.actor_id=q.requested_by
   AND a.action='finance.supplier_invoice.recognition_completed' AND a.resource_type='supplier_invoice' AND a.resource_id=q.invoice_id
   AND a.reason=q.reason AND a.after->>'recognitionRequestId'=q.id::text AND a.after->>'recognitionOutcomeId'=NEW.id::text
   AND a.after->>'state'=NEW.state AND (a.after->>'recognitionId') IS NOT DISTINCT FROM NEW.recognition_id::text
   AND (a.after->>'failureCode') IS NOT DISTINCT FROM NEW.failure_code)
 THEN RAISE EXCEPTION 'recognition outcome requires its attributed atomic audit'; END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER supplier_invoice_recognition_outcome_complete AFTER INSERT ON supplier_invoice_recognition_outcome
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app_supplier_invoice_recognition_outcome_complete();

CREATE FUNCTION app_supplier_invoice_recognition_event_integrity() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE q supplier_invoice_recognition_request%ROWTYPE;
BEGIN
 IF TG_OP='DELETE' THEN
  IF OLD.type='SupplierInvoiceRecognitionRequested' OR OLD.idempotency_key LIKE 'supplier-invoice-recognition:%:requested'
  THEN RAISE EXCEPTION 'recognition dispatch business facts are immutable'; END IF;
  RETURN OLD;
 END IF;
 IF TG_OP='UPDATE' AND (OLD.type='SupplierInvoiceRecognitionRequested' OR OLD.idempotency_key LIKE 'supplier-invoice-recognition:%:requested')
   AND ROW(NEW.id,NEW.organization_id,NEW.type,NEW.payload,NEW.idempotency_key,NEW.occurred_at,NEW.created_at)
     IS DISTINCT FROM ROW(OLD.id,OLD.organization_id,OLD.type,OLD.payload,OLD.idempotency_key,OLD.occurred_at,OLD.created_at)
 THEN RAISE EXCEPTION 'recognition dispatch business facts are immutable'; END IF;
 IF NEW.type='SupplierInvoiceRecognitionRequested' OR NEW.idempotency_key LIKE 'supplier-invoice-recognition:%:requested' THEN
  SELECT * INTO q FROM supplier_invoice_recognition_request WHERE organization_id=NEW.organization_id AND id::text=NEW.payload->>'requestId';
  IF q.id IS NULL OR NEW.type<>'SupplierInvoiceRecognitionRequested'
    OR NEW.idempotency_key<>'supplier-invoice-recognition:'||q.id::text||':requested'
    OR NEW.payload<>jsonb_build_object('requestId',q.id::text) OR NEW.occurred_at<>date_trunc('milliseconds',q.requested_at)
  THEN RAISE EXCEPTION 'recognition dispatch must identify its exact actual request'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER supplier_invoice_recognition_event_integrity BEFORE INSERT OR UPDATE OR DELETE ON outbox_event
 FOR EACH ROW EXECUTE FUNCTION app_supplier_invoice_recognition_event_integrity();

COMMIT;
