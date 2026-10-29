BEGIN;

-- CreateTable
CREATE TABLE "supplier_invoice" (
    "id" UUID NOT NULL DEFAULT app_uuid_v7(),
    "organization_id" UUID NOT NULL,
    "supplier_id" UUID NOT NULL,
    "reference" TEXT NOT NULL,
    "invoice_number" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'DRAFT',
    "version" INTEGER NOT NULL DEFAULT 0,
    "current_revision_id" UUID,
    "idempotency_key" UUID NOT NULL,
    "request_fingerprint" TEXT NOT NULL,
    "archived_at" TIMESTAMPTZ(6),
    "created_by" UUID NOT NULL,
    "updated_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "supplier_invoice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "supplier_invoice_revision" (
    "id" UUID NOT NULL DEFAULT app_uuid_v7(),
    "organization_id" UUID NOT NULL,
    "invoice_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "invoice_number" TEXT NOT NULL,
    "issued_on" DATE NOT NULL,
    "due_on" DATE,
    "amount" DECIMAL(18,2) NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "purpose" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "supplier_invoice_revision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "supplier_invoice_line" (
    "id" UUID NOT NULL DEFAULT app_uuid_v7(),
    "organization_id" UUID NOT NULL,
    "revision_id" UUID NOT NULL,
    "position" INTEGER NOT NULL,
    "property_id" UUID,
    "reservation_id" UUID,
    "category" TEXT NOT NULL,
    "cost_center" TEXT,
    "amount" DECIMAL(18,2) NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "supplier_invoice_line_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "supplier_invoice_organization_id_archived_at_id_idx" ON "supplier_invoice"("organization_id", "archived_at", "id");

-- CreateIndex
CREATE INDEX "supplier_invoice_organization_id_supplier_id_state_id_idx" ON "supplier_invoice"("organization_id", "supplier_id", "state", "id");

-- CreateIndex
CREATE UNIQUE INDEX "supplier_invoice_organization_id_id_key" ON "supplier_invoice"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "supplier_invoice_organization_id_reference_key" ON "supplier_invoice"("organization_id", "reference");

-- CreateIndex
CREATE UNIQUE INDEX "supplier_invoice_organization_id_supplier_id_invoice_number_key" ON "supplier_invoice"("organization_id", "supplier_id", "invoice_number");

-- CreateIndex
CREATE UNIQUE INDEX "supplier_invoice_organization_id_idempotency_key_key" ON "supplier_invoice"("organization_id", "idempotency_key");

-- CreateIndex
CREATE INDEX "supplier_invoice_revision_organization_id_due_on_id_idx" ON "supplier_invoice_revision"("organization_id", "due_on", "id");

-- CreateIndex
CREATE UNIQUE INDEX "supplier_invoice_revision_organization_id_id_key" ON "supplier_invoice_revision"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "supplier_invoice_revision_organization_id_invoice_id_versio_key" ON "supplier_invoice_revision"("organization_id", "invoice_id", "version");

-- CreateIndex
CREATE INDEX "supplier_invoice_line_organization_id_property_id_revision__idx" ON "supplier_invoice_line"("organization_id", "property_id", "revision_id");

-- CreateIndex
CREATE INDEX "supplier_invoice_line_organization_id_reservation_id_idx" ON "supplier_invoice_line"("organization_id", "reservation_id");

-- CreateIndex
CREATE UNIQUE INDEX "supplier_invoice_line_organization_id_id_key" ON "supplier_invoice_line"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "supplier_invoice_line_organization_id_revision_id_position_key" ON "supplier_invoice_line"("organization_id", "revision_id", "position");

-- AddForeignKey
ALTER TABLE "supplier_invoice" ADD CONSTRAINT "supplier_invoice_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "supplier_invoice" ADD CONSTRAINT "supplier_invoice_organization_id_supplier_id_fkey" FOREIGN KEY ("organization_id", "supplier_id") REFERENCES "supplier"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "supplier_invoice" ADD CONSTRAINT "supplier_invoice_organization_id_created_by_fkey" FOREIGN KEY ("organization_id", "created_by") REFERENCES "user_account"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "supplier_invoice" ADD CONSTRAINT "supplier_invoice_organization_id_updated_by_fkey" FOREIGN KEY ("organization_id", "updated_by") REFERENCES "user_account"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "supplier_invoice" ADD CONSTRAINT "supplier_invoice_organization_id_current_revision_id_fkey" FOREIGN KEY ("organization_id", "current_revision_id") REFERENCES "supplier_invoice_revision"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "supplier_invoice_revision" ADD CONSTRAINT "supplier_invoice_revision_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "supplier_invoice_revision" ADD CONSTRAINT "supplier_invoice_revision_organization_id_invoice_id_fkey" FOREIGN KEY ("organization_id", "invoice_id") REFERENCES "supplier_invoice"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "supplier_invoice_revision" ADD CONSTRAINT "supplier_invoice_revision_organization_id_created_by_fkey" FOREIGN KEY ("organization_id", "created_by") REFERENCES "user_account"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "supplier_invoice_line" ADD CONSTRAINT "supplier_invoice_line_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "supplier_invoice_line" ADD CONSTRAINT "supplier_invoice_line_organization_id_revision_id_fkey" FOREIGN KEY ("organization_id", "revision_id") REFERENCES "supplier_invoice_revision"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "supplier_invoice_line" ADD CONSTRAINT "supplier_invoice_line_organization_id_property_id_fkey" FOREIGN KEY ("organization_id", "property_id") REFERENCES "property"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "supplier_invoice_line" ADD CONSTRAINT "supplier_invoice_line_organization_id_reservation_id_fkey" FOREIGN KEY ("organization_id", "reservation_id") REFERENCES "reservation"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "supplier_invoice_line" ADD CONSTRAINT "supplier_invoice_line_organization_id_created_by_fkey" FOREIGN KEY ("organization_id", "created_by") REFERENCES "user_account"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;


ALTER TABLE supplier_invoice ALTER CONSTRAINT supplier_invoice_organization_id_current_revision_id_fkey DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE supplier_invoice ADD CONSTRAINT supplier_invoice_draft_fields CHECK
 (state='DRAFT' AND version>=0 AND current_revision_id IS NOT NULL AND length(btrim(invoice_number)) BETWEEN 1 AND 160 AND length(request_fingerprint)=64);
ALTER TABLE supplier_invoice_revision ADD CONSTRAINT supplier_invoice_revision_fields CHECK
 (version>=0 AND amount>0 AND currency ~ '^[A-Z]{3}$' AND length(btrim(invoice_number)) BETWEEN 1 AND 160
  AND length(btrim(purpose)) BETWEEN 3 AND 1000 AND length(btrim(reason)) BETWEEN 6 AND 500);
ALTER TABLE supplier_invoice_line ADD CONSTRAINT supplier_invoice_line_fields CHECK
 (position>0 AND amount>0 AND currency ~ '^[A-Z]{3}$' AND category ~ '^[a-z][a-z0-9_.-]{0,119}$'
  AND (cost_center IS NULL OR length(btrim(cost_center)) BETWEEN 1 AND 120) AND (reservation_id IS NULL OR property_id IS NOT NULL));

ALTER TABLE supplier_invoice ENABLE ROW LEVEL SECURITY;
ALTER TABLE supplier_invoice FORCE ROW LEVEL SECURITY;
CREATE POLICY supplier_invoice_tenant_isolation ON supplier_invoice
 USING (organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid)
 WITH CHECK (organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid);
ALTER TABLE supplier_invoice_revision ENABLE ROW LEVEL SECURITY;
ALTER TABLE supplier_invoice_revision FORCE ROW LEVEL SECURITY;
CREATE POLICY supplier_invoice_revision_tenant_isolation ON supplier_invoice_revision
 USING (organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid)
 WITH CHECK (organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid);
ALTER TABLE supplier_invoice_line ENABLE ROW LEVEL SECURITY;
ALTER TABLE supplier_invoice_line FORCE ROW LEVEL SECURITY;
CREATE POLICY supplier_invoice_line_tenant_isolation ON supplier_invoice_line
 USING (organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid)
 WITH CHECK (organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid);

CREATE TRIGGER supplier_invoice_no_delete BEFORE DELETE ON supplier_invoice FOR EACH ROW EXECUTE FUNCTION app_prevent_business_row_delete();
CREATE FUNCTION app_supplier_invoice_history_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'supplier invoice source revisions and lines are append-only'; END; $$;
CREATE TRIGGER supplier_invoice_revision_immutable BEFORE UPDATE OR DELETE ON supplier_invoice_revision FOR EACH ROW EXECUTE FUNCTION app_supplier_invoice_history_immutable();
CREATE TRIGGER supplier_invoice_line_immutable BEFORE UPDATE OR DELETE ON supplier_invoice_line FOR EACH ROW EXECUTE FUNCTION app_supplier_invoice_history_immutable();

CREATE FUNCTION app_supplier_invoice_draft_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='INSERT' THEN
  IF NEW.version<>0 OR NEW.created_by<>NEW.updated_by OR NEW.archived_at IS NOT NULL THEN RAISE EXCEPTION 'supplier invoice starts at an attributed active version zero'; END IF;
 ELSE
  IF ROW(NEW.id,NEW.organization_id,NEW.supplier_id,NEW.reference,NEW.idempotency_key,NEW.request_fingerprint,NEW.created_by,NEW.created_at)
    IS DISTINCT FROM ROW(OLD.id,OLD.organization_id,OLD.supplier_id,OLD.reference,OLD.idempotency_key,OLD.request_fingerprint,OLD.created_by,OLD.created_at)
    OR NEW.version<>OLD.version+1 THEN RAISE EXCEPTION 'supplier invoice identity is immutable and edits require the next source version'; END IF;
  IF NEW.current_revision_id=OLD.current_revision_id THEN
   IF (NEW.archived_at IS NULL)=(OLD.archived_at IS NULL) OR NEW.invoice_number<>OLD.invoice_number THEN RAISE EXCEPTION 'supplier invoice changes require a new revision or archive transition'; END IF;
  ELSIF OLD.archived_at IS NOT NULL OR NEW.archived_at IS DISTINCT FROM OLD.archived_at THEN
   RAISE EXCEPTION 'archived supplier invoices cannot change their source revision';
  END IF;
 END IF;
 NEW.updated_at=clock_timestamp(); RETURN NEW;
END; $$;
CREATE TRIGGER supplier_invoice_draft_guard BEFORE INSERT OR UPDATE ON supplier_invoice FOR EACH ROW EXECUTE FUNCTION app_supplier_invoice_draft_guard();

CREATE FUNCTION app_assert_supplier_invoice_revision(org_uuid uuid,revision_uuid uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE revision supplier_invoice_revision%ROWTYPE; invoice supplier_invoice%ROWTYPE; line_count bigint; line_total numeric; valid boolean;
BEGIN
 SELECT * INTO revision FROM supplier_invoice_revision WHERE organization_id=org_uuid AND id=revision_uuid;
 IF NOT FOUND THEN RAISE EXCEPTION 'supplier invoice requires its complete source revision'; END IF;
 SELECT * INTO invoice FROM supplier_invoice WHERE organization_id=org_uuid AND id=revision.invoice_id;
 IF NOT FOUND OR invoice.current_revision_id<>revision.id OR invoice.version<revision.version OR invoice.invoice_number<>revision.invoice_number THEN
  RAISE EXCEPTION 'supplier invoice revision must belong to its current invoice source'; END IF;
 SELECT COUNT(*),SUM(l.amount),COALESCE(BOOL_AND(l.currency=revision.currency AND l.created_by=revision.created_by
   AND (l.reservation_id IS NULL OR EXISTS (SELECT 1 FROM reservation r WHERE r.organization_id=org_uuid AND r.id=l.reservation_id AND r.property_id=l.property_id))),false)
   AND COALESCE(MIN(l.position)=1 AND MAX(l.position)=COUNT(*),false)
 INTO line_count,line_total,valid FROM supplier_invoice_line l WHERE l.organization_id=org_uuid AND l.revision_id=revision.id;
 IF line_count=0 OR line_total<>revision.amount OR NOT valid THEN RAISE EXCEPTION 'supplier invoice lines must conserve the exact source total, currency, author and property'; END IF;
END; $$;

CREATE FUNCTION app_supplier_invoice_revision_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE revision_uuid uuid; revision supplier_invoice_revision%ROWTYPE; invoice supplier_invoice%ROWTYPE;
BEGIN
 IF TG_TABLE_NAME='supplier_invoice_revision' THEN revision_uuid=NEW.id; ELSE revision_uuid=NEW.revision_id; END IF;
 PERFORM app_assert_supplier_invoice_revision(NEW.organization_id,revision_uuid);
 SELECT * INTO revision FROM supplier_invoice_revision WHERE organization_id=NEW.organization_id AND id=revision_uuid;
 SELECT * INTO invoice FROM supplier_invoice WHERE organization_id=NEW.organization_id AND id=revision.invoice_id;
 IF invoice.version<>revision.version OR invoice.updated_by<>revision.created_by THEN RAISE EXCEPTION 'new supplier invoice revisions require the current source version and author'; END IF;
 IF NOT EXISTS (SELECT 1 FROM audit_log a WHERE a.organization_id=NEW.organization_id AND a.resource_type='supplier_invoice' AND a.resource_id=revision.invoice_id
   AND a.action IN ('finance.supplier_invoice.draft_created','finance.supplier_invoice.draft_updated') AND a.actor_id=revision.created_by
   AND a.after->>'revisionId'=revision.id::text AND a.after->>'version'=revision.version::text AND a.reason=revision.reason) THEN
  RAISE EXCEPTION 'supplier invoice revisions require their attributed source audit'; END IF;
 RETURN NEW;
END; $$;
CREATE CONSTRAINT TRIGGER supplier_invoice_revision_complete AFTER INSERT ON supplier_invoice_revision DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app_supplier_invoice_revision_guard();
CREATE CONSTRAINT TRIGGER supplier_invoice_line_complete AFTER INSERT ON supplier_invoice_line DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app_supplier_invoice_revision_guard();

CREATE FUNCTION app_supplier_invoice_audit_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE expected_action text;
BEGIN
 PERFORM app_assert_supplier_invoice_revision(NEW.organization_id,NEW.current_revision_id);
 IF TG_OP='INSERT' THEN expected_action='finance.supplier_invoice.draft_created';
 ELSIF NEW.current_revision_id<>OLD.current_revision_id THEN expected_action='finance.supplier_invoice.draft_updated';
 ELSIF NEW.archived_at IS NULL THEN expected_action='finance.supplier_invoice.draft_restored';
 ELSE expected_action='finance.supplier_invoice.draft_archived'; END IF;
 IF NOT EXISTS (SELECT 1 FROM audit_log a WHERE a.organization_id=NEW.organization_id AND a.resource_type='supplier_invoice' AND a.resource_id=NEW.id
   AND a.action=expected_action AND a.actor_id=NEW.updated_by AND a.after->>'revisionId'=NEW.current_revision_id::text
   AND a.after->>'version'=NEW.version::text AND length(btrim(a.reason))>0) THEN RAISE EXCEPTION 'supplier invoice changes require an attributed versioned audit'; END IF;
 RETURN NEW;
END; $$;
CREATE CONSTRAINT TRIGGER supplier_invoice_audit_guard AFTER INSERT OR UPDATE ON supplier_invoice DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app_supplier_invoice_audit_guard();

COMMIT;
