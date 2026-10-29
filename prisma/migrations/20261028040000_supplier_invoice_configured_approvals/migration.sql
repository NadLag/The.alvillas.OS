BEGIN;
-- AlterTable
ALTER TABLE "approval_request" ADD COLUMN     "invoice_submission_id" UUID,
ALTER COLUMN "property_id" DROP NOT NULL;

-- AlterTable
ALTER TABLE "approval_stage" ADD COLUMN     "invoice_line_id" UUID,
ADD COLUMN     "property_id" UUID,
ADD COLUMN     "reservation_id" UUID,
ADD COLUMN     "source_snapshot" JSONB;

-- AlterTable
ALTER TABLE "supplier_invoice" ADD COLUMN     "current_submission_id" UUID;

-- CreateTable
CREATE TABLE "supplier_invoice_submission" (
    "id" UUID NOT NULL DEFAULT app_uuid_v7(),
    "organization_id" UUID NOT NULL,
    "invoice_id" UUID NOT NULL,
    "revision_id" UUID NOT NULL,
    "source_invoice_version" INTEGER NOT NULL,
    "occurred_on" DATE NOT NULL,
    "emergency" BOOLEAN NOT NULL,
    "reason" VARCHAR(500) NOT NULL,
    "snapshot" JSONB NOT NULL,
    "idempotency_key" UUID NOT NULL,
    "request_fingerprint" TEXT NOT NULL,
    "submitted_by" UUID NOT NULL,
    "submitted_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "supplier_invoice_submission_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "supplier_invoice_submission_organization_id_invoice_id_subm_idx" ON "supplier_invoice_submission"("organization_id", "invoice_id", "submitted_at", "id");

-- CreateIndex
CREATE UNIQUE INDEX "supplier_invoice_submission_organization_id_id_key" ON "supplier_invoice_submission"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "supplier_invoice_submission_organization_id_invoice_id_revi_key" ON "supplier_invoice_submission"("organization_id", "invoice_id", "revision_id");

-- CreateIndex
CREATE UNIQUE INDEX "supplier_invoice_submission_organization_id_invoice_id_sour_key" ON "supplier_invoice_submission"("organization_id", "invoice_id", "source_invoice_version");

-- CreateIndex
CREATE UNIQUE INDEX "supplier_invoice_submission_organization_id_idempotency_key_key" ON "supplier_invoice_submission"("organization_id", "idempotency_key");

-- CreateIndex
CREATE UNIQUE INDEX "approval_request_org_invoice_submission_unique" ON "approval_request"("organization_id", "invoice_submission_id");

-- AddForeignKey
ALTER TABLE "approval_request" ADD CONSTRAINT "approval_request_organization_id_invoice_submission_id_fkey" FOREIGN KEY ("organization_id", "invoice_submission_id") REFERENCES "supplier_invoice_submission"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "approval_stage" ADD CONSTRAINT "approval_stage_organization_id_invoice_line_id_fkey" FOREIGN KEY ("organization_id", "invoice_line_id") REFERENCES "supplier_invoice_line"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "approval_stage" ADD CONSTRAINT "approval_stage_organization_id_property_id_fkey" FOREIGN KEY ("organization_id", "property_id") REFERENCES "property"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "approval_stage" ADD CONSTRAINT "approval_stage_organization_id_reservation_id_fkey" FOREIGN KEY ("organization_id", "reservation_id") REFERENCES "reservation"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "supplier_invoice" ADD CONSTRAINT "supplier_invoice_organization_id_current_submission_id_fkey" FOREIGN KEY ("organization_id", "current_submission_id") REFERENCES "supplier_invoice_submission"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "supplier_invoice_submission" ADD CONSTRAINT "supplier_invoice_submission_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "supplier_invoice_submission" ADD CONSTRAINT "supplier_invoice_submission_organization_id_invoice_id_fkey" FOREIGN KEY ("organization_id", "invoice_id") REFERENCES "supplier_invoice"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "supplier_invoice_submission" ADD CONSTRAINT "supplier_invoice_submission_organization_id_revision_id_fkey" FOREIGN KEY ("organization_id", "revision_id") REFERENCES "supplier_invoice_revision"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "supplier_invoice_submission" ADD CONSTRAINT "supplier_invoice_submission_organization_id_submitted_by_fkey" FOREIGN KEY ("organization_id", "submitted_by") REFERENCES "user_account"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;


-- Forward-only source and approval guards. Existing source, financial and approval rows are not updated.
ALTER TABLE supplier_invoice DROP CONSTRAINT supplier_invoice_draft_fields;
ALTER TABLE supplier_invoice ADD CONSTRAINT supplier_invoice_draft_fields CHECK
 (state IN ('DRAFT','PENDING_APPROVAL','APPROVED','REJECTED') AND version>=0 AND current_revision_id IS NOT NULL
  AND length(btrim(invoice_number)) BETWEEN 1 AND 160 AND length(request_fingerprint)=64
  AND ((state='DRAFT' AND current_submission_id IS NULL) OR (state<>'DRAFT' AND current_submission_id IS NOT NULL AND archived_at IS NULL)));
ALTER TABLE approval_request ADD CONSTRAINT approval_request_source_kind CHECK
 (NOT (expense_id IS NOT NULL AND invoice_submission_id IS NOT NULL)
  AND ((invoice_submission_id IS NULL AND property_id IS NOT NULL) OR (invoice_submission_id IS NOT NULL AND property_id IS NULL)));
ALTER TABLE approval_stage DROP CONSTRAINT approval_stage_positive_amount;
ALTER TABLE approval_stage ADD CONSTRAINT approval_stage_positive_amount CHECK
 (amount>0 OR (amount=0 AND invoice_line_id IS NOT NULL));
ALTER TABLE supplier_invoice_submission ADD CONSTRAINT supplier_invoice_submission_fields CHECK
 (source_invoice_version>=0 AND length(btrim(reason)) BETWEEN 6 AND 500 AND length(request_fingerprint)=64);
ALTER TABLE supplier_invoice_submission ENABLE ROW LEVEL SECURITY;
ALTER TABLE supplier_invoice_submission FORCE ROW LEVEL SECURITY;
CREATE POLICY supplier_invoice_submission_tenant_isolation ON supplier_invoice_submission
 USING (organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid)
 WITH CHECK (organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid);
CREATE TRIGGER supplier_invoice_submission_immutable BEFORE UPDATE OR DELETE ON supplier_invoice_submission
 FOR EACH ROW EXECUTE FUNCTION app_prevent_ledger_mutation();

CREATE OR REPLACE FUNCTION app_supplier_invoice_draft_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='INSERT' THEN
  IF NEW.state<>'DRAFT' OR NEW.version<>0 OR NEW.created_by<>NEW.updated_by OR NEW.archived_at IS NOT NULL OR NEW.current_submission_id IS NOT NULL
   THEN RAISE EXCEPTION 'supplier invoice starts at an attributed active draft version zero'; END IF;
 ELSE
  IF ROW(NEW.id,NEW.organization_id,NEW.supplier_id,NEW.reference,NEW.idempotency_key,NEW.request_fingerprint,NEW.created_by,NEW.created_at)
    IS DISTINCT FROM ROW(OLD.id,OLD.organization_id,OLD.supplier_id,OLD.reference,OLD.idempotency_key,OLD.request_fingerprint,OLD.created_by,OLD.created_at)
    OR NEW.version<>OLD.version+1 THEN RAISE EXCEPTION 'supplier invoice identity is immutable and transitions require the next source version'; END IF;
  IF NEW.current_revision_id IS DISTINCT FROM OLD.current_revision_id THEN
   IF OLD.state NOT IN ('DRAFT','REJECTED') OR NEW.state<>'DRAFT' OR OLD.archived_at IS NOT NULL
    OR NEW.archived_at IS DISTINCT FROM OLD.archived_at OR NEW.current_submission_id IS NOT NULL
    THEN RAISE EXCEPTION 'supplier invoice revisions require an active draft or rejected source'; END IF;
  ELSIF ROW(NEW.invoice_number,NEW.archived_at) IS DISTINCT FROM ROW(OLD.invoice_number,OLD.archived_at) THEN
   IF OLD.state<>'DRAFT' OR NEW.state<>'DRAFT' OR NEW.invoice_number<>OLD.invoice_number
    OR (NEW.archived_at IS NULL)=(OLD.archived_at IS NULL) OR NEW.current_submission_id IS DISTINCT FROM OLD.current_submission_id
    THEN RAISE EXCEPTION 'only draft archive visibility may change without a revision'; END IF;
  ELSIF OLD.state='DRAFT' AND NEW.state='PENDING_APPROVAL' THEN
   IF OLD.archived_at IS NOT NULL OR OLD.current_submission_id IS NOT NULL OR NEW.current_submission_id IS NULL
    THEN RAISE EXCEPTION 'supplier invoice submission requires its active draft'; END IF;
  ELSIF OLD.state='PENDING_APPROVAL' AND NEW.state IN ('APPROVED','REJECTED') THEN
   IF NEW.current_submission_id IS DISTINCT FROM OLD.current_submission_id THEN RAISE EXCEPTION 'supplier invoice approval source is immutable'; END IF;
  ELSE RAISE EXCEPTION 'supplier invoice state transition is invalid'; END IF;
 END IF;
 NEW.updated_at=clock_timestamp(); RETURN NEW;
END; $$;

CREATE OR REPLACE FUNCTION app_supplier_invoice_audit_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE expected_action text; source supplier_invoice_submission%ROWTYPE;
BEGIN
 PERFORM app_assert_supplier_invoice_revision(NEW.organization_id,NEW.current_revision_id);
 IF TG_OP='INSERT' THEN expected_action='finance.supplier_invoice.draft_created';
 ELSIF NEW.current_revision_id<>OLD.current_revision_id THEN expected_action='finance.supplier_invoice.draft_updated';
 ELSIF NEW.state='PENDING_APPROVAL' THEN expected_action='finance.supplier_invoice.submitted';
 ELSIF NEW.state IN ('APPROVED','REJECTED') THEN
  SELECT * INTO source FROM supplier_invoice_submission WHERE organization_id=NEW.organization_id AND id=NEW.current_submission_id;
  IF NEW.state='REJECTED' THEN expected_action='finance.supplier_invoice.rejected';
  ELSIF jsonb_array_length(source.snapshot->'stages')=0 THEN expected_action='finance.supplier_invoice.approved_by_policy';
  ELSE expected_action='finance.supplier_invoice.approved'; END IF;
 ELSIF NEW.archived_at IS NULL THEN expected_action='finance.supplier_invoice.draft_restored';
 ELSE expected_action='finance.supplier_invoice.draft_archived'; END IF;
 IF NOT EXISTS (SELECT 1 FROM audit_log a WHERE a.organization_id=NEW.organization_id AND a.resource_type='supplier_invoice' AND a.resource_id=NEW.id
   AND a.action=expected_action AND a.actor_id=NEW.updated_by AND a.after->>'revisionId'=NEW.current_revision_id::text
   AND a.after->>'version'=NEW.version::text AND length(btrim(a.reason))>0
   AND (NEW.state='DRAFT' OR (a.after->>'submissionId'=NEW.current_submission_id::text AND a.after->>'state'=NEW.state)))
  THEN RAISE EXCEPTION 'supplier invoice changes require an attributed versioned source audit'; END IF;
 RETURN NEW;
END; $$;

CREATE OR REPLACE FUNCTION app_financial_approval_header_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE e expense%ROWTYPE; s supplier_invoice_submission%ROWTYPE; i supplier_invoice%ROWTYPE; source_pending boolean;
BEGIN
 IF TG_OP='DELETE' THEN
  IF OLD.expense_id IS NOT NULL OR OLD.invoice_submission_id IS NOT NULL THEN RAISE EXCEPTION 'financial approval history cannot be deleted'; END IF;
  RETURN OLD;
 END IF;
 IF TG_OP='UPDATE' AND (OLD.expense_id IS NOT NULL OR NEW.expense_id IS NOT NULL OR OLD.invoice_submission_id IS NOT NULL OR NEW.invoice_submission_id IS NOT NULL) THEN
  IF ROW(NEW.id,NEW.organization_id,NEW.expense_id,NEW.invoice_submission_id,NEW.property_id,NEW.requested_by,NEW.title,NEW.details,NEW.routing_snapshot,NEW.idempotency_key,NEW.created_at)
   IS DISTINCT FROM ROW(OLD.id,OLD.organization_id,OLD.expense_id,OLD.invoice_submission_id,OLD.property_id,OLD.requested_by,OLD.title,OLD.details,OLD.routing_snapshot,OLD.idempotency_key,OLD.created_at)
  THEN RAISE EXCEPTION 'financial approval source and routing are immutable'; END IF;
 END IF;
 IF NEW.expense_id IS NULL AND NEW.invoice_submission_id IS NULL THEN RETURN NEW; END IF;
 IF NEW.expense_id IS NOT NULL THEN
  SELECT * INTO e FROM expense WHERE organization_id=NEW.organization_id AND id=NEW.expense_id;
  IF NOT FOUND OR e.property_id IS DISTINCT FROM NEW.property_id OR NOT EXISTS (
    SELECT 1 FROM expense_submission x WHERE x.organization_id=e.organization_id AND x.expense_id=e.id AND x.submitted_by=NEW.requested_by)
   THEN RAISE EXCEPTION 'financial approval requires its original submitted source'; END IF;
  source_pending=e.state='PENDING_APPROVAL';
 ELSE
  SELECT * INTO s FROM supplier_invoice_submission WHERE organization_id=NEW.organization_id AND id=NEW.invoice_submission_id;
  SELECT * INTO i FROM supplier_invoice WHERE organization_id=NEW.organization_id AND id=s.invoice_id;
  IF s.id IS NULL OR i.current_submission_id IS DISTINCT FROM s.id OR s.submitted_by<>NEW.requested_by OR NEW.property_id IS NOT NULL
   THEN RAISE EXCEPTION 'financial approval requires its original submitted invoice source'; END IF;
  source_pending=i.state='PENDING_APPROVAL';
 END IF;
 IF TG_OP='INSERT' THEN
  IF NEW.state<>'PENDING' OR NOT source_pending OR NEW.decided_by IS NOT NULL OR NEW.decided_at IS NOT NULL OR NEW.decision_reason IS NOT NULL
   THEN RAISE EXCEPTION 'financial approval starts pending'; END IF;
 ELSIF NEW.state IS DISTINCT FROM OLD.state THEN
  IF OLD.state<>'PENDING' OR NEW.state NOT IN ('APPROVED','REJECTED') OR NEW.decided_by IS NULL OR NEW.decided_at IS NULL OR length(trim(COALESCE(NEW.decision_reason,'')))<6
   THEN RAISE EXCEPTION 'financial approval decision requires immutable attribution'; END IF;
  IF NOT EXISTS (SELECT 1 FROM approval_stage x WHERE x.organization_id=NEW.organization_id AND x.approval_id=NEW.id AND x.state=NEW.state
      AND x.decided_by=NEW.decided_by AND x.decided_at=NEW.decided_at AND x.decision_reason=NEW.decision_reason)
   OR EXISTS (SELECT 1 FROM approval_stage x WHERE x.organization_id=NEW.organization_id AND x.approval_id=NEW.id
      AND (x.state='PENDING' OR (NEW.state='APPROVED' AND x.state<>'APPROVED')))
   THEN RAISE EXCEPTION 'financial approval must finish its configured stages'; END IF;
 ELSIF ROW(NEW.decided_by,NEW.decided_at,NEW.decision_reason) IS DISTINCT FROM ROW(OLD.decided_by,OLD.decided_at,OLD.decision_reason)
  THEN RAISE EXCEPTION 'financial approval decision is immutable'; END IF;
 RETURN NEW;
END; $$;

CREATE OR REPLACE FUNCTION app_financial_recipient_history_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF EXISTS (SELECT 1 FROM approval_request a WHERE a.organization_id=OLD.organization_id AND a.id=OLD.approval_id
   AND (a.expense_id IS NOT NULL OR a.invoice_submission_id IS NOT NULL)) THEN RAISE EXCEPTION 'financial approval recipients are append-only'; END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF; RETURN NEW;
END; $$;

CREATE FUNCTION app_invoice_approval_stage_source_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE a approval_request%ROWTYPE; s supplier_invoice_submission%ROWTYPE; l supplier_invoice_line%ROWTYPE; source_line jsonb;
BEGIN
 SELECT * INTO a FROM approval_request WHERE organization_id=NEW.organization_id AND id=NEW.approval_id;
 IF a.invoice_submission_id IS NULL THEN
  IF NEW.invoice_line_id IS NOT NULL OR NEW.property_id IS NOT NULL OR NEW.reservation_id IS NOT NULL OR NEW.source_snapshot IS NOT NULL
   THEN RAISE EXCEPTION 'non-invoice approval cannot adopt an invoice source'; END IF;
  RETURN NEW;
 END IF;
 IF TG_OP='UPDATE' AND ROW(NEW.invoice_line_id,NEW.property_id,NEW.reservation_id,NEW.source_snapshot)
  IS DISTINCT FROM ROW(OLD.invoice_line_id,OLD.property_id,OLD.reservation_id,OLD.source_snapshot) THEN RAISE EXCEPTION 'invoice approval stage source is immutable'; END IF;
 SELECT * INTO s FROM supplier_invoice_submission WHERE organization_id=NEW.organization_id AND id=a.invoice_submission_id;
 SELECT * INTO l FROM supplier_invoice_line WHERE organization_id=NEW.organization_id AND id=NEW.invoice_line_id;
 SELECT x INTO source_line FROM jsonb_array_elements(s.snapshot->'lines') x WHERE x->>'id'=l.id::text;
 IF l.id IS NULL OR l.revision_id<>s.revision_id OR l.property_id IS DISTINCT FROM NEW.property_id OR l.reservation_id IS DISTINCT FROM NEW.reservation_id
  OR NEW.source_snapshot IS NULL OR NEW.source_snapshot->>'lineId' IS DISTINCT FROM l.id::text OR NEW.source_snapshot->>'category' IS DISTINCT FROM l.category
  OR NEW.source_snapshot->>'occurredOn' IS DISTINCT FROM s.occurred_on::text OR COALESCE(length(btrim(NEW.source_snapshot->>'note')),0) NOT BETWEEN 6 AND 1000
  OR NEW.source_snapshot->>'note' IS DISTINCT FROM source_line->>'approvalNote'
  OR NEW.source_snapshot->>'timezone' IS DISTINCT FROM source_line->'policy'->>'timezone'
  THEN RAISE EXCEPTION 'invoice approval stage requires its actual immutable cost source'; END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER invoice_approval_stage_source_guard BEFORE INSERT OR UPDATE ON approval_stage
 FOR EACH ROW EXECUTE FUNCTION app_invoice_approval_stage_source_guard();

CREATE FUNCTION app_assert_supplier_invoice_submission(org_uuid uuid,source_uuid uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE s supplier_invoice_submission%ROWTYPE; i supplier_invoice%ROWTYPE; r supplier_invoice_revision%ROWTYPE; a approval_request%ROWTYPE;
 expected jsonb; entry jsonb; step approval_stage%ROWTYPE; source_count integer; source_recipients text[]; actual_recipients text[];
BEGIN
 SELECT * INTO s FROM supplier_invoice_submission WHERE organization_id=org_uuid AND id=source_uuid;
 SELECT * INTO i FROM supplier_invoice WHERE organization_id=org_uuid AND id=s.invoice_id;
 SELECT * INTO r FROM supplier_invoice_revision WHERE organization_id=org_uuid AND id=s.revision_id;
 IF s.id IS NULL OR i.id IS NULL OR r.invoice_id IS DISTINCT FROM i.id OR i.current_submission_id IS DISTINCT FROM s.id OR i.current_revision_id IS DISTINCT FROM r.id
  OR i.version<s.source_invoice_version+1 OR s.snapshot->>'invoiceId' IS DISTINCT FROM i.id::text OR s.snapshot->>'revisionId' IS DISTINCT FROM r.id::text
  OR s.snapshot->>'sourceInvoiceVersion' IS DISTINCT FROM s.source_invoice_version::text OR s.snapshot->>'occurredOn' IS DISTINCT FROM s.occurred_on::text
  OR s.snapshot->>'emergency' IS DISTINCT FROM s.emergency::text OR (s.snapshot->'amount'->>'amount')::numeric IS DISTINCT FROM r.amount OR s.snapshot->'amount'->>'currency' IS DISTINCT FROM r.currency
  OR jsonb_typeof(s.snapshot->'lines') IS DISTINCT FROM 'array' OR jsonb_typeof(s.snapshot->'stages') IS DISTINCT FROM 'array'
  THEN RAISE EXCEPTION 'supplier invoice submission requires its exact immutable source facts'; END IF;
 SELECT count(*) INTO source_count FROM supplier_invoice_line WHERE organization_id=org_uuid AND revision_id=r.id;
 IF source_count<>jsonb_array_length(s.snapshot->'lines') OR EXISTS (
  SELECT 1 FROM jsonb_array_elements(s.snapshot->'lines') x LEFT JOIN supplier_invoice_line l ON l.organization_id=org_uuid AND l.id=(x->>'id')::uuid AND l.revision_id=r.id
  WHERE l.id IS NULL OR l.position IS DISTINCT FROM (x->>'position')::integer OR l.property_id::text IS DISTINCT FROM x->>'propertyId'
   OR l.reservation_id::text IS DISTINCT FROM x->>'reservationId' OR l.amount IS DISTINCT FROM (x->'amount'->>'amount')::numeric OR l.currency IS DISTINCT FROM x->'amount'->>'currency'
   OR l.category IS DISTINCT FROM x->>'category' OR l.cost_center IS DISTINCT FROM x->>'costCenter' OR COALESCE(length(btrim(x->>'approvalNote')),0) NOT BETWEEN 6 AND 1000
   OR x->'policy'->>'sourceKind' IS DISTINCT FROM 'supplier_invoice_line' OR x->'policy'->>'invoiceId' IS DISTINCT FROM i.id::text
   OR x->'policy'->>'revisionId' IS DISTINCT FROM r.id::text OR x->'policy'->>'lineId' IS DISTINCT FROM l.id::text
   OR x->'policy'->>'occurredOn' IS DISTINCT FROM s.occurred_on::text OR COALESCE(length(x->'policy'->>'timezone'),0)=0
   OR ((x->'policy'->'allocation'->'owner'->>'amount')::numeric+(x->'policy'->'allocation'->'alvillas'->>'amount')::numeric
     +(x->'policy'->'allocation'->'guest'->>'amount')::numeric) IS DISTINCT FROM l.amount
   OR EXISTS (SELECT 1 FROM (VALUES (x->'policy'->'allocation'->'owner'),(x->'policy'->'allocation'->'alvillas'),(x->'policy'->'allocation'->'guest')) allocation(value)
     WHERE value->>'currency' IS DISTINCT FROM l.currency OR (value->>'amount')::numeric<0 OR trunc((value->>'amount')::numeric*100)<>(value->>'amount')::numeric*100))
  OR (SELECT count(DISTINCT x->>'id') FROM jsonb_array_elements(s.snapshot->'lines') x)<>source_count
  THEN RAISE EXCEPTION 'supplier invoice submission must preserve every actual allocation line and its review note'; END IF;
 IF NOT EXISTS (SELECT 1 FROM audit_log x WHERE x.organization_id=org_uuid AND x.resource_type='supplier_invoice' AND x.resource_id=i.id
   AND x.action='finance.supplier_invoice.submitted' AND x.actor_id=s.submitted_by AND x.reason=s.reason
   AND x.after->>'submissionId'=s.id::text AND x.after->>'revisionId'=r.id::text AND x.after->>'version'=(s.source_invoice_version+1)::text)
  THEN RAISE EXCEPTION 'supplier invoice submission requires its attributed source audit'; END IF;
 SELECT * INTO a FROM approval_request WHERE organization_id=org_uuid AND invoice_submission_id=s.id;
 IF jsonb_array_length(s.snapshot->'stages')=0 THEN
  IF a.id IS NOT NULL OR i.state<>'APPROVED' THEN RAISE EXCEPTION 'invoice without required review must be approved by its explicit policy'; END IF;
 ELSE
  IF a.id IS NULL OR a.state<>i.state OR (a.state<>'PENDING' AND a.decided_by<>i.updated_by)
   OR (SELECT count(*) FROM approval_stage WHERE organization_id=org_uuid AND approval_id=a.id)<>jsonb_array_length(s.snapshot->'stages')
   THEN RAISE EXCEPTION 'supplier invoice requires its complete configured approval'; END IF;
  FOR expected,source_count IN SELECT value,ordinality::integer FROM jsonb_array_elements(s.snapshot->'stages') WITH ORDINALITY LOOP
   SELECT * INTO step FROM approval_stage WHERE organization_id=org_uuid AND approval_id=a.id AND position=source_count;
   IF step.id IS NULL OR step.kind IS DISTINCT FROM expected->>'kind' OR step.owner_id::text IS DISTINCT FROM expected->>'ownerId'
    OR step.amount IS DISTINCT FROM (expected->>'amount')::numeric OR step.currency IS DISTINCT FROM expected->>'currency'
    OR step.invoice_line_id::text IS DISTINCT FROM expected->>'lineId' OR step.property_id::text IS DISTINCT FROM expected->>'propertyId'
    OR step.reservation_id::text IS DISTINCT FROM expected->>'reservationId' OR step.source_snapshot IS DISTINCT FROM expected->'sourceSnapshot'
    OR step.routing_snapshot IS DISTINCT FROM expected->'routing' THEN RAISE EXCEPTION 'supplier invoice approval must match its frozen policy stage'; END IF;
   SELECT array_agg(value ORDER BY value) INTO source_recipients FROM jsonb_array_elements_text(expected->'recipients');
   SELECT array_agg(user_account_id::text ORDER BY user_account_id::text) INTO actual_recipients FROM approval_stage_recipient WHERE organization_id=org_uuid AND stage_id=step.id;
   IF source_recipients IS DISTINCT FROM actual_recipients OR COALESCE(array_length(source_recipients,1),0)=0
    THEN RAISE EXCEPTION 'supplier invoice approval audience must match its frozen policy'; END IF;
   IF step.state IN ('APPROVED','REJECTED') AND NOT EXISTS (SELECT 1 FROM audit_log x WHERE x.organization_id=org_uuid AND x.resource_type='supplier_invoice'
     AND x.resource_id=i.id AND x.action='finance.supplier_invoice.approval_stage_decided' AND x.actor_id=step.decided_by
     AND x.after->>'stageId'=step.id::text AND x.after->>'state'=step.state AND x.after->>'lineId'=step.invoice_line_id::text)
    THEN RAISE EXCEPTION 'supplier invoice approval decisions require their attributed source audit'; END IF;
  END LOOP;
  SELECT array_agg(DISTINCT x.user_account_id::text ORDER BY x.user_account_id::text) INTO source_recipients FROM approval_stage_recipient x
    JOIN approval_stage y ON y.organization_id=x.organization_id AND y.id=x.stage_id WHERE x.organization_id=org_uuid AND y.approval_id=a.id;
  SELECT array_agg(user_account_id::text ORDER BY user_account_id::text) INTO actual_recipients FROM approval_recipient WHERE organization_id=org_uuid AND approval_id=a.id;
  IF source_recipients IS DISTINCT FROM actual_recipients THEN RAISE EXCEPTION 'supplier invoice approval audience must match its stage audience'; END IF;
 END IF;
END; $$;

CREATE FUNCTION app_supplier_invoice_submission_integrity_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE source_uuid uuid; approval_uuid uuid;
BEGIN
 IF TG_TABLE_NAME='supplier_invoice_submission' THEN source_uuid=NEW.id;
 ELSIF TG_TABLE_NAME='supplier_invoice' THEN source_uuid=NEW.current_submission_id;
 ELSIF TG_TABLE_NAME='approval_request' THEN source_uuid=NEW.invoice_submission_id;
 ELSIF TG_TABLE_NAME IN ('approval_stage','approval_recipient') THEN approval_uuid=NEW.approval_id;
 ELSE SELECT approval_id INTO approval_uuid FROM approval_stage WHERE organization_id=NEW.organization_id AND id=NEW.stage_id; END IF;
 IF source_uuid IS NULL AND approval_uuid IS NOT NULL THEN SELECT invoice_submission_id INTO source_uuid FROM approval_request WHERE organization_id=NEW.organization_id AND id=approval_uuid; END IF;
 IF source_uuid IS NOT NULL THEN PERFORM app_assert_supplier_invoice_submission(NEW.organization_id,source_uuid); END IF;
 RETURN NEW;
END; $$;
CREATE CONSTRAINT TRIGGER supplier_invoice_submission_integrity AFTER INSERT ON supplier_invoice_submission DEFERRABLE INITIALLY DEFERRED
 FOR EACH ROW EXECUTE FUNCTION app_supplier_invoice_submission_integrity_guard();
CREATE CONSTRAINT TRIGGER supplier_invoice_submitted_source_integrity AFTER INSERT OR UPDATE ON supplier_invoice DEFERRABLE INITIALLY DEFERRED
 FOR EACH ROW EXECUTE FUNCTION app_supplier_invoice_submission_integrity_guard();
CREATE CONSTRAINT TRIGGER supplier_invoice_approval_integrity AFTER INSERT OR UPDATE ON approval_request DEFERRABLE INITIALLY DEFERRED
 FOR EACH ROW EXECUTE FUNCTION app_supplier_invoice_submission_integrity_guard();
CREATE CONSTRAINT TRIGGER supplier_invoice_stage_integrity AFTER INSERT OR UPDATE ON approval_stage DEFERRABLE INITIALLY DEFERRED
 FOR EACH ROW EXECUTE FUNCTION app_supplier_invoice_submission_integrity_guard();
CREATE CONSTRAINT TRIGGER supplier_invoice_audience_integrity AFTER INSERT ON approval_recipient DEFERRABLE INITIALLY DEFERRED
 FOR EACH ROW EXECUTE FUNCTION app_supplier_invoice_submission_integrity_guard();
CREATE CONSTRAINT TRIGGER supplier_invoice_stage_audience_integrity AFTER INSERT ON approval_stage_recipient DEFERRABLE INITIALLY DEFERRED
 FOR EACH ROW EXECUTE FUNCTION app_supplier_invoice_submission_integrity_guard();

COMMIT;
