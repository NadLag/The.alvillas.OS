BEGIN;
-- AlterTable
ALTER TABLE "approval_request" ADD COLUMN     "employee_submission_id" UUID;

-- AlterTable
ALTER TABLE "approval_stage" ADD COLUMN     "employee_cost_id" UUID;

-- CreateTable
CREATE TABLE "employee_compensation_submission" (
    "id" UUID NOT NULL DEFAULT app_uuid_v7(),
    "organization_id" UUID NOT NULL,
    "run_id" UUID NOT NULL,
    "submitted_by" UUID NOT NULL,
    "idempotency_key" UUID NOT NULL,
    "request_fingerprint" CHAR(64) NOT NULL,
    "cost_on" DATE NOT NULL,
    "emergency" BOOLEAN NOT NULL,
    "reason" VARCHAR(500) NOT NULL,
    "snapshot" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "employee_compensation_submission_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "employee_compensation_claim" (
    "id" UUID NOT NULL DEFAULT app_uuid_v7(),
    "organization_id" UUID NOT NULL,
    "submission_id" UUID NOT NULL,
    "person_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "employee_compensation_claim_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "employee_compensation_cost" (
    "id" UUID NOT NULL DEFAULT app_uuid_v7(),
    "organization_id" UUID NOT NULL,
    "submission_id" UUID NOT NULL,
    "claim_id" UUID NOT NULL,
    "run_line_id" UUID NOT NULL,
    "completion_event_id" UUID NOT NULL,
    "property_id" UUID NOT NULL,
    "reservation_id" UUID,
    "amount" DECIMAL(18,2) NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "category" VARCHAR(120) NOT NULL,
    "cost_center" VARCHAR(120),
    "note" VARCHAR(1000) NOT NULL,
    "timezone" VARCHAR(120) NOT NULL,
    "policy_snapshot" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "employee_compensation_cost_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "employee_compensation_withdrawal" (
    "id" UUID NOT NULL DEFAULT app_uuid_v7(),
    "organization_id" UUID NOT NULL,
    "submission_id" UUID NOT NULL,
    "withdrawn_by" UUID NOT NULL,
    "reason" VARCHAR(500) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "employee_compensation_withdrawal_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "employee_submission_run_history_idx" ON "employee_compensation_submission"("organization_id", "run_id", "created_at", "id");

-- CreateIndex
CREATE UNIQUE INDEX "employee_compensation_submission_organization_id_id_key" ON "employee_compensation_submission"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "employee_submission_nonce_unique" ON "employee_compensation_submission"("organization_id", "idempotency_key");

-- CreateIndex
CREATE INDEX "employee_claim_person_idx" ON "employee_compensation_claim"("organization_id", "person_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "employee_compensation_claim_organization_id_id_key" ON "employee_compensation_claim"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "employee_claim_submission_person_unique" ON "employee_compensation_claim"("organization_id", "submission_id", "person_id");

-- CreateIndex
CREATE INDEX "employee_cost_completion_idx" ON "employee_compensation_cost"("organization_id", "completion_event_id", "submission_id");

-- CreateIndex
CREATE UNIQUE INDEX "employee_compensation_cost_organization_id_id_key" ON "employee_compensation_cost"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "employee_cost_source_unique" ON "employee_compensation_cost"("organization_id", "submission_id", "run_line_id");

-- CreateIndex
CREATE UNIQUE INDEX "employee_cost_completion_unique" ON "employee_compensation_cost"("organization_id", "submission_id", "completion_event_id");

-- CreateIndex
CREATE UNIQUE INDEX "employee_compensation_withdrawal_organization_id_id_key" ON "employee_compensation_withdrawal"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "employee_submission_withdrawal_unique" ON "employee_compensation_withdrawal"("organization_id", "submission_id");

-- CreateIndex
CREATE UNIQUE INDEX "approval_request_org_employee_submission_unique" ON "approval_request"("organization_id", "employee_submission_id");

-- AddForeignKey
ALTER TABLE "approval_request" ADD CONSTRAINT "approval_request_organization_id_employee_submission_id_fkey" FOREIGN KEY ("organization_id", "employee_submission_id") REFERENCES "employee_compensation_submission"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "approval_stage" ADD CONSTRAINT "approval_stage_organization_id_employee_cost_id_fkey" FOREIGN KEY ("organization_id", "employee_cost_id") REFERENCES "employee_compensation_cost"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "employee_compensation_submission" ADD CONSTRAINT "employee_compensation_submission_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "employee_compensation_submission" ADD CONSTRAINT "employee_compensation_submission_organization_id_run_id_fkey" FOREIGN KEY ("organization_id", "run_id") REFERENCES "employee_compensation_run"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "employee_compensation_submission" ADD CONSTRAINT "employee_compensation_submission_organization_id_submitted_fkey" FOREIGN KEY ("organization_id", "submitted_by") REFERENCES "user_account"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "employee_compensation_claim" ADD CONSTRAINT "employee_compensation_claim_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "employee_compensation_claim" ADD CONSTRAINT "employee_compensation_claim_organization_id_submission_id_fkey" FOREIGN KEY ("organization_id", "submission_id") REFERENCES "employee_compensation_submission"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "employee_compensation_claim" ADD CONSTRAINT "employee_compensation_claim_organization_id_person_id_fkey" FOREIGN KEY ("organization_id", "person_id") REFERENCES "person"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "employee_compensation_cost" ADD CONSTRAINT "employee_compensation_cost_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "employee_compensation_cost" ADD CONSTRAINT "employee_compensation_cost_organization_id_submission_id_fkey" FOREIGN KEY ("organization_id", "submission_id") REFERENCES "employee_compensation_submission"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "employee_compensation_cost" ADD CONSTRAINT "employee_compensation_cost_organization_id_claim_id_fkey" FOREIGN KEY ("organization_id", "claim_id") REFERENCES "employee_compensation_claim"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "employee_compensation_cost" ADD CONSTRAINT "employee_compensation_cost_organization_id_run_line_id_fkey" FOREIGN KEY ("organization_id", "run_line_id") REFERENCES "employee_compensation_run_line"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "employee_compensation_cost" ADD CONSTRAINT "employee_compensation_cost_organization_id_completion_even_fkey" FOREIGN KEY ("organization_id", "completion_event_id") REFERENCES "operation_task_event"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "employee_compensation_cost" ADD CONSTRAINT "employee_compensation_cost_organization_id_property_id_fkey" FOREIGN KEY ("organization_id", "property_id") REFERENCES "property"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "employee_compensation_cost" ADD CONSTRAINT "employee_compensation_cost_organization_id_reservation_id_fkey" FOREIGN KEY ("organization_id", "reservation_id") REFERENCES "reservation"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "employee_compensation_cost" ADD CONSTRAINT "employee_compensation_cost_currency_fkey" FOREIGN KEY ("currency") REFERENCES "currency"("code") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "employee_compensation_withdrawal" ADD CONSTRAINT "employee_compensation_withdrawal_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "employee_compensation_withdrawal" ADD CONSTRAINT "employee_compensation_withdrawal_organization_id_submissio_fkey" FOREIGN KEY ("organization_id", "submission_id") REFERENCES "employee_compensation_submission"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "employee_compensation_withdrawal" ADD CONSTRAINT "employee_compensation_withdrawal_organization_id_withdrawn_fkey" FOREIGN KEY ("organization_id", "withdrawn_by") REFERENCES "user_account"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;


CREATE OR REPLACE FUNCTION public.app_financial_approval_header_guard()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE e expense%ROWTYPE; s supplier_invoice_submission%ROWTYPE; i supplier_invoice%ROWTYPE; source_pending boolean;
BEGIN
 IF TG_OP='DELETE' THEN
  IF OLD.expense_id IS NOT NULL OR (OLD.invoice_submission_id IS NOT NULL OR OLD.employee_submission_id IS NOT NULL) THEN RAISE EXCEPTION 'financial approval history cannot be deleted'; END IF;
  RETURN OLD;
 END IF;
 IF TG_OP='UPDATE' AND (OLD.expense_id IS NOT NULL OR NEW.expense_id IS NOT NULL OR (OLD.invoice_submission_id IS NOT NULL OR OLD.employee_submission_id IS NOT NULL) OR (NEW.invoice_submission_id IS NOT NULL OR NEW.employee_submission_id IS NOT NULL)) THEN
  IF ROW(NEW.id,NEW.organization_id,NEW.expense_id,NEW.invoice_submission_id,NEW.employee_submission_id,NEW.property_id,NEW.requested_by,NEW.title,NEW.details,NEW.routing_snapshot,NEW.idempotency_key,NEW.created_at)
   IS DISTINCT FROM ROW(OLD.id,OLD.organization_id,OLD.expense_id,OLD.invoice_submission_id,OLD.employee_submission_id,OLD.property_id,OLD.requested_by,OLD.title,OLD.details,OLD.routing_snapshot,OLD.idempotency_key,OLD.created_at)
  THEN RAISE EXCEPTION 'financial approval source and routing are immutable'; END IF;
 END IF;
 IF NEW.expense_id IS NULL AND NEW.invoice_submission_id IS NULL AND NEW.employee_submission_id IS NULL THEN RETURN NEW; END IF;
 IF NEW.expense_id IS NOT NULL THEN
  SELECT * INTO e FROM expense WHERE organization_id=NEW.organization_id AND id=NEW.expense_id;
  IF NOT FOUND OR e.property_id IS DISTINCT FROM NEW.property_id OR NOT EXISTS (
    SELECT 1 FROM expense_submission x WHERE x.organization_id=e.organization_id AND x.expense_id=e.id AND x.submitted_by=NEW.requested_by)
   THEN RAISE EXCEPTION 'financial approval requires its original submitted source'; END IF;
  source_pending=e.state='PENDING_APPROVAL';
 ELSIF NEW.employee_submission_id IS NOT NULL THEN
  IF NOT EXISTS(SELECT 1 FROM employee_compensation_submission x WHERE x.organization_id=NEW.organization_id AND x.id=NEW.employee_submission_id AND x.submitted_by=NEW.requested_by)
   OR NEW.property_id IS NOT NULL THEN RAISE EXCEPTION 'employee approval requires its original submitter'; END IF;
  source_pending=NOT EXISTS(SELECT 1 FROM employee_compensation_withdrawal w WHERE w.organization_id=NEW.organization_id AND w.submission_id=NEW.employee_submission_id);
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
END; $function$;
CREATE OR REPLACE FUNCTION public.app_validate_approval_property()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
 IF NEW.employee_submission_id IS NOT NULL THEN
  IF NEW.property_id IS NOT NULL OR NOT EXISTS(SELECT 1 FROM employee_compensation_submission s WHERE s.organization_id=NEW.organization_id AND s.id=NEW.employee_submission_id)
   THEN RAISE EXCEPTION 'employee approval tenant mismatch';END IF;RETURN NEW;
 END IF;
 IF NEW.invoice_submission_id IS NOT NULL THEN
  IF NEW.property_id IS NOT NULL OR NOT EXISTS (SELECT 1 FROM supplier_invoice_submission s WHERE s.organization_id=NEW.organization_id AND s.id=NEW.invoice_submission_id)
   THEN RAISE EXCEPTION 'approval invoice source tenant mismatch'; END IF;
 ELSIF NOT EXISTS (SELECT 1 FROM property WHERE id=NEW.property_id AND organization_id=NEW.organization_id)
  THEN RAISE EXCEPTION 'approval property tenant mismatch'; END IF;
 RETURN NEW;
END; $function$;
CREATE OR REPLACE FUNCTION public.app_invoice_approval_stage_source_guard()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE a approval_request%ROWTYPE; s supplier_invoice_submission%ROWTYPE; l supplier_invoice_line%ROWTYPE; source_line jsonb; expected jsonb;
BEGIN
 SELECT * INTO a FROM approval_request WHERE organization_id=NEW.organization_id AND id=NEW.approval_id;
 IF a.employee_submission_id IS NOT NULL THEN RETURN NEW; END IF;
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
 expected=s.snapshot->'stages'->(NEW.position-1);
 IF l.id IS NULL OR l.revision_id<>s.revision_id OR l.property_id IS DISTINCT FROM NEW.property_id OR l.reservation_id IS DISTINCT FROM NEW.reservation_id
  OR NEW.source_snapshot IS NULL OR NEW.source_snapshot->>'lineId' IS DISTINCT FROM l.id::text OR NEW.source_snapshot->>'category' IS DISTINCT FROM l.category
  OR NEW.source_snapshot->>'occurredOn' IS DISTINCT FROM s.occurred_on::text OR COALESCE(length(btrim(NEW.source_snapshot->>'note')),0) NOT BETWEEN 6 AND 1000
  OR NEW.source_snapshot->>'note' IS DISTINCT FROM source_line->>'approvalNote' OR NEW.source_snapshot->>'timezone' IS DISTINCT FROM source_line->'policy'->>'timezone'
  OR expected IS NULL OR NEW.kind IS DISTINCT FROM expected->>'kind' OR NEW.owner_id::text IS DISTINCT FROM expected->>'ownerId'
  OR NEW.amount IS DISTINCT FROM (expected->>'amount')::numeric OR NEW.currency IS DISTINCT FROM expected->>'currency'
  OR NEW.invoice_line_id::text IS DISTINCT FROM expected->>'lineId' OR NEW.property_id::text IS DISTINCT FROM expected->>'propertyId'
  OR NEW.reservation_id::text IS DISTINCT FROM expected->>'reservationId' OR NEW.routing_snapshot IS DISTINCT FROM expected->'routing'
  OR NEW.source_snapshot IS DISTINCT FROM expected->'sourceSnapshot'
  THEN RAISE EXCEPTION 'invoice approval stage requires its exact frozen cost policy'; END IF;
 RETURN NEW;
END; $function$;
CREATE OR REPLACE FUNCTION public.app_financial_recipient_history_guard()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
 IF EXISTS (SELECT 1 FROM approval_request a WHERE a.organization_id=OLD.organization_id AND a.id=OLD.approval_id
   AND (a.expense_id IS NOT NULL OR a.invoice_submission_id IS NOT NULL OR a.employee_submission_id IS NOT NULL)) THEN RAISE EXCEPTION 'financial approval recipients are append-only'; END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF; RETURN NEW;
END; $function$;
CREATE OR REPLACE FUNCTION public.app_financial_stage_order_guard()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE a approval_request%ROWTYPE;
BEGIN
 SELECT * INTO a FROM approval_request WHERE organization_id=NEW.organization_id AND id=NEW.approval_id FOR UPDATE;
 IF a.employee_submission_id IS NOT NULL AND EXISTS(SELECT 1 FROM employee_compensation_withdrawal w WHERE w.organization_id=a.organization_id AND w.submission_id=a.employee_submission_id)
 THEN RAISE EXCEPTION 'withdrawn employee review cannot receive a new decision';END IF;
 IF a.state<>'PENDING' THEN RAISE EXCEPTION 'financial approval is no longer pending'; END IF;
 IF NEW.state IN ('APPROVED','REJECTED') THEN
  IF EXISTS (SELECT 1 FROM approval_stage s WHERE s.organization_id=NEW.organization_id AND s.approval_id=NEW.approval_id AND s.position<NEW.position AND s.state<>'APPROVED')
   OR NOT EXISTS (SELECT 1 FROM approval_stage_recipient r WHERE r.organization_id=NEW.organization_id AND r.stage_id=NEW.id AND r.user_account_id=NEW.decided_by)
  THEN RAISE EXCEPTION 'financial approval requires its ordered recipient'; END IF;
 ELSIF NEW.state='CANCELLED' AND NOT EXISTS (SELECT 1 FROM approval_stage s WHERE s.organization_id=NEW.organization_id AND s.approval_id=NEW.approval_id
   AND s.position<NEW.position AND s.state='REJECTED' AND s.decided_by=NEW.decided_by AND s.decided_at=NEW.decided_at AND s.decision_reason=NEW.decision_reason)
 THEN RAISE EXCEPTION 'financial stage cancellation requires its preceding rejection'; END IF;
 RETURN NEW;
END $function$;
ALTER TABLE approval_request DROP CONSTRAINT approval_request_source_kind;
ALTER TABLE approval_request ADD CONSTRAINT approval_request_source_kind CHECK
 (num_nonnulls(expense_id,invoice_submission_id,employee_submission_id)<=1
 AND ((invoice_submission_id IS NULL AND employee_submission_id IS NULL AND property_id IS NOT NULL)
 OR (num_nonnulls(invoice_submission_id,employee_submission_id)=1 AND property_id IS NULL)));

ALTER TABLE employee_compensation_submission ADD CONSTRAINT employee_submission_intent CHECK
 (length(btrim(reason))>=6 AND request_fingerprint~'^[0-9a-f]{64}$' AND jsonb_typeof(snapshot)='object');
ALTER TABLE employee_compensation_cost ADD CONSTRAINT employee_cost_positive_source CHECK
 (amount>0 AND length(btrim(note))>=6 AND length(btrim(category))>0 AND jsonb_typeof(policy_snapshot)='object');
ALTER TABLE employee_compensation_withdrawal ADD CONSTRAINT employee_withdrawal_reason CHECK(length(btrim(reason))>=6);

CREATE FUNCTION app_employee_submission_admission() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended(NEW.organization_id::text||':employee-compensation-run:'||NEW.run_id::text,0));
 IF NOT EXISTS(SELECT 1 FROM employee_compensation_run r WHERE r.organization_id=NEW.organization_id AND r.id=NEW.run_id)
  OR EXISTS(SELECT 1 FROM employee_compensation_run_cancellation c WHERE c.organization_id=NEW.organization_id AND c.run_id=NEW.run_id)
 THEN RAISE EXCEPTION 'employee submission requires its active original completed-work run'; END IF;
 NEW.created_at=clock_timestamp();RETURN NEW;
END $$;
CREATE TRIGGER employee_submission_admission BEFORE INSERT ON employee_compensation_submission FOR EACH ROW EXECUTE FUNCTION app_employee_submission_admission();

CREATE FUNCTION app_employee_cost_admission() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE s employee_compensation_submission%ROWTYPE; c employee_compensation_claim%ROWTYPE; l employee_compensation_run_line%ROWTYPE; expected jsonb; source_xid text;
BEGIN
 SELECT * INTO s FROM employee_compensation_submission WHERE organization_id=NEW.organization_id AND id=NEW.submission_id;
 SELECT xmin::text INTO source_xid FROM employee_compensation_submission WHERE organization_id=NEW.organization_id AND id=NEW.submission_id;
 IF s.id IS NULL OR source_xid::bigint<>mod(pg_current_xact_id()::text::numeric,4294967296)::bigint
 THEN RAISE EXCEPTION 'employee claim sources are admitted with their original submission only'; END IF;
 IF TG_TABLE_NAME='employee_compensation_claim' THEN
  IF NOT EXISTS(SELECT 1 FROM employee_compensation_run_line x WHERE x.organization_id=NEW.organization_id AND x.run_id=s.run_id AND x.person_id=NEW.person_id AND x.amount>0)
  THEN RAISE EXCEPTION 'employee claim requires its actual positive-work beneficiary'; END IF;
 ELSE
  SELECT * INTO c FROM employee_compensation_claim WHERE organization_id=NEW.organization_id AND id=NEW.claim_id;
  SELECT * INTO l FROM employee_compensation_run_line WHERE organization_id=NEW.organization_id AND id=NEW.run_line_id;
  SELECT value INTO expected FROM jsonb_array_elements(s.snapshot->'costs') WHERE value->>'runLineId'=NEW.run_line_id::text;
  IF c.id IS NULL OR l.id IS NULL OR c.submission_id<>s.id OR l.run_id<>s.run_id OR l.person_id<>c.person_id
   OR l.amount<>NEW.amount OR l.currency<>NEW.currency OR l.completion_event_id<>NEW.completion_event_id OR l.property_id<>NEW.property_id
   OR expected IS NULL OR expected->>'personId' IS DISTINCT FROM c.person_id::text
   OR expected->>'completionEventId' IS DISTINCT FROM NEW.completion_event_id::text OR expected->>'propertyId' IS DISTINCT FROM NEW.property_id::text
   OR expected->>'reservationId' IS DISTINCT FROM NEW.reservation_id::text OR expected->>'category' IS DISTINCT FROM NEW.category
   OR expected->>'costCenter' IS DISTINCT FROM NEW.cost_center OR expected->>'note' IS DISTINCT FROM NEW.note OR expected->>'timezone' IS DISTINCT FROM NEW.timezone
   OR expected->>'costOn' IS DISTINCT FROM s.cost_on::text OR (expected#>>'{amount,amount}')::numeric IS DISTINCT FROM NEW.amount
   OR expected#>>'{amount,currency}' IS DISTINCT FROM NEW.currency OR expected->'policy' IS DISTINCT FROM NEW.policy_snapshot
   OR NEW.reservation_id IS DISTINCT FROM (SELECT (after->>'reservation_id')::uuid FROM operation_task_event WHERE organization_id=NEW.organization_id AND id=NEW.completion_event_id)
  THEN RAISE EXCEPTION 'employee cost requires its exact immutable completed-work source and policy'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.organization_id::text||':employee-earned-source:'||NEW.completion_event_id::text,0));
  IF EXISTS(SELECT 1 FROM employee_compensation_cost old_cost JOIN employee_compensation_submission prior ON prior.organization_id=old_cost.organization_id AND prior.id=old_cost.submission_id
   LEFT JOIN approval_request a ON a.organization_id=prior.organization_id AND a.employee_submission_id=prior.id
   WHERE old_cost.organization_id=NEW.organization_id AND old_cost.completion_event_id=NEW.completion_event_id AND prior.id<>s.id
    AND NOT EXISTS(SELECT 1 FROM employee_compensation_withdrawal w WHERE w.organization_id=prior.organization_id AND w.submission_id=prior.id)
    AND COALESCE(a.state,'APPROVED')<>'REJECTED')
  THEN RAISE EXCEPTION 'completed work already belongs to an active employee claim'; END IF;
 END IF;
 NEW.created_at=clock_timestamp();RETURN NEW;
END $$;

CREATE FUNCTION app_employee_stage_source() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE a approval_request%ROWTYPE; s employee_compensation_submission%ROWTYPE; c employee_compensation_cost%ROWTYPE; expected jsonb;
BEGIN
 SELECT * INTO a FROM approval_request WHERE organization_id=NEW.organization_id AND id=NEW.approval_id;
 IF a.employee_submission_id IS NULL THEN
  IF NEW.employee_cost_id IS NOT NULL THEN RAISE EXCEPTION 'employee review requires its actual submission'; END IF;
  RETURN NEW;
 END IF;
 SELECT * INTO s FROM employee_compensation_submission WHERE organization_id=NEW.organization_id AND id=a.employee_submission_id;
 SELECT * INTO c FROM employee_compensation_cost WHERE organization_id=NEW.organization_id AND id=NEW.employee_cost_id;
 expected=s.snapshot->'stages'->(NEW.position-1);
 IF TG_OP='UPDATE' AND ROW(NEW.employee_cost_id,NEW.property_id,NEW.reservation_id,NEW.source_snapshot)
  IS DISTINCT FROM ROW(OLD.employee_cost_id,OLD.property_id,OLD.reservation_id,OLD.source_snapshot)
 THEN RAISE EXCEPTION 'employee approval source is immutable'; END IF;
 IF c.id IS NULL OR c.submission_id<>s.id OR NEW.invoice_line_id IS NOT NULL OR c.property_id IS DISTINCT FROM NEW.property_id OR c.reservation_id IS DISTINCT FROM NEW.reservation_id
  OR expected IS NULL OR expected->>'runLineId' IS DISTINCT FROM c.run_line_id::text OR expected->>'kind' IS DISTINCT FROM NEW.kind
  OR expected->>'ownerId' IS DISTINCT FROM NEW.owner_id::text OR (expected->>'amount')::numeric IS DISTINCT FROM NEW.amount
  OR expected->>'currency' IS DISTINCT FROM NEW.currency OR expected->'routing' IS DISTINCT FROM NEW.routing_snapshot
  OR NEW.source_snapshot IS DISTINCT FROM jsonb_build_object('lineId',c.id::text,'note',c.note,'category',c.category,'occurredOn',s.cost_on::text,'timezone',c.timezone,'createdBy',s.submitted_by::text)
 THEN RAISE EXCEPTION 'employee approval requires its exact original cost slice'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER employee_stage_source BEFORE INSERT OR UPDATE ON approval_stage FOR EACH ROW EXECUTE FUNCTION app_employee_stage_source();

CREATE FUNCTION app_assert_employee_submission(org uuid,source_id uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE s employee_compensation_submission%ROWTYPE; r employee_compensation_run%ROWTYPE; a approval_request%ROWTYPE; cost_count integer; total_amount numeric; expected jsonb; stage approval_stage%ROWTYPE; audience text[]; actual text[];
BEGIN
 SELECT * INTO s FROM employee_compensation_submission WHERE organization_id=org AND id=source_id;IF NOT FOUND THEN RETURN; END IF;
 SELECT * INTO r FROM employee_compensation_run WHERE organization_id=org AND id=s.run_id;
 SELECT count(*),sum(amount) INTO cost_count,total_amount FROM employee_compensation_cost WHERE organization_id=org AND submission_id=s.id;
 IF r.id IS NULL OR cost_count=0 OR cost_count<>(SELECT count(*) FROM employee_compensation_run_line WHERE organization_id=org AND run_id=r.id AND amount>0)
  OR cost_count<>jsonb_array_length(s.snapshot->'costs') OR total_amount IS DISTINCT FROM (s.snapshot#>>'{total,amount}')::numeric
  OR s.snapshot->>'kind' IS DISTINCT FROM 'EMPLOYEE_COMPENSATION_COSTS' OR s.snapshot->>'runId' IS DISTINCT FROM r.id::text OR s.snapshot->>'costOn' IS DISTINCT FROM s.cost_on::text
  OR s.snapshot#>>'{total,currency}' IS DISTINCT FROM r.currency
  OR EXISTS(SELECT 1 FROM employee_compensation_claim claim WHERE claim.organization_id=org AND claim.submission_id=s.id
   AND NOT EXISTS(SELECT 1 FROM employee_compensation_cost cost WHERE cost.organization_id=org AND cost.claim_id=claim.id))
 THEN RAISE EXCEPTION 'employee submission requires every original positive source and derived total'; END IF;
 SELECT * INTO a FROM approval_request WHERE organization_id=org AND employee_submission_id=s.id;
 IF jsonb_array_length(s.snapshot->'stages')=0 THEN
  IF a.id IS NOT NULL THEN RAISE EXCEPTION 'employee review cannot add an unconfigured stage'; END IF;
 ELSE
  IF a.id IS NULL OR (SELECT count(*) FROM approval_stage WHERE organization_id=org AND approval_id=a.id)<>jsonb_array_length(s.snapshot->'stages')
  THEN RAISE EXCEPTION 'employee submission requires its complete configured review'; END IF;
  FOR stage IN SELECT * FROM approval_stage WHERE organization_id=org AND approval_id=a.id ORDER BY position LOOP
   expected=s.snapshot->'stages'->(stage.position-1);
   SELECT array_agg(value ORDER BY value) INTO audience FROM jsonb_array_elements_text(expected->'recipients');
   SELECT array_agg(user_account_id::text ORDER BY user_account_id::text) INTO actual FROM approval_stage_recipient WHERE organization_id=org AND stage_id=stage.id;
   IF audience IS NULL OR actual IS DISTINCT FROM audience THEN RAISE EXCEPTION 'employee review requires its frozen stage audience'; END IF;
  END LOOP;
  SELECT array_agg(DISTINCT member ORDER BY member) INTO audience FROM jsonb_array_elements(s.snapshot->'stages') stage CROSS JOIN LATERAL jsonb_array_elements_text(stage->'recipients') member;
  SELECT array_agg(user_account_id::text ORDER BY user_account_id::text) INTO actual FROM approval_recipient WHERE organization_id=org AND approval_id=a.id;
  IF actual IS DISTINCT FROM audience THEN RAISE EXCEPTION 'employee review requires only its frozen audience'; END IF;
 END IF;
 IF (SELECT count(*) FROM audit_log WHERE organization_id=org AND resource_type='employee_compensation_submission' AND resource_id=s.id AND action='finance.employee_compensation.submitted')<>1
  OR NOT EXISTS(SELECT 1 FROM audit_log WHERE organization_id=org AND resource_type='employee_compensation_submission' AND resource_id=s.id AND action='finance.employee_compensation.submitted'
   AND actor_id=s.submitted_by AND reason=s.reason AND after->>'submissionId'=s.id::text AND after->>'runId'=r.id::text
   AND (after->>'costCount')::integer=cost_count AND (after->>'claimCount')::integer=(SELECT count(*) FROM employee_compensation_claim WHERE organization_id=org AND submission_id=s.id)
   AND (after#>>'{total,amount}')::numeric=total_amount AND after#>>'{total,currency}'=r.currency)
  OR NOT EXISTS(SELECT 1 FROM outbox_event WHERE organization_id=org AND type='EmployeeCompensationSubmitted' AND idempotency_key='employee-compensation-submission:'||s.id::text||':EmployeeCompensationSubmitted' AND payload=jsonb_build_object('submissionId',s.id::text))
 THEN RAISE EXCEPTION 'employee submission requires its actual atomic attribution and event'; END IF;
END $$;

CREATE FUNCTION app_employee_submission_complete() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE source_id uuid; approval_id uuid;
BEGIN
 IF TG_TABLE_NAME='employee_compensation_submission' THEN source_id=NEW.id;
 ELSIF TG_TABLE_NAME IN('employee_compensation_claim','employee_compensation_cost') THEN source_id=NEW.submission_id;
 ELSIF TG_TABLE_NAME='approval_request' THEN source_id=NEW.employee_submission_id;
 ELSIF TG_TABLE_NAME='approval_stage' THEN approval_id=NEW.approval_id;
 ELSIF TG_TABLE_NAME='approval_stage_recipient' THEN SELECT s.approval_id INTO approval_id FROM approval_stage s WHERE s.organization_id=NEW.organization_id AND s.id=NEW.stage_id;
 ELSIF TG_TABLE_NAME='approval_recipient' THEN approval_id=NEW.approval_id;
 ELSIF TG_TABLE_NAME='audit_log' THEN IF NEW.resource_type='employee_compensation_submission' THEN source_id=NEW.resource_id;END IF;
 ELSIF TG_TABLE_NAME='outbox_event' THEN IF NEW.type='EmployeeCompensationSubmitted' THEN source_id=(NEW.payload->>'submissionId')::uuid;END IF; END IF;
 IF approval_id IS NOT NULL THEN SELECT employee_submission_id INTO source_id FROM approval_request WHERE organization_id=NEW.organization_id AND id=approval_id; END IF;
 IF source_id IS NOT NULL THEN PERFORM app_assert_employee_submission(NEW.organization_id,source_id); END IF;RETURN NEW;
END $$;

CREATE FUNCTION app_employee_withdrawal_complete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF (SELECT count(*) FROM audit_log WHERE organization_id=NEW.organization_id AND resource_type='employee_compensation_submission' AND resource_id=NEW.submission_id
  AND action='finance.employee_compensation.withdrawn' AND actor_id=NEW.withdrawn_by AND reason=NEW.reason AND after->>'withdrawalId'=NEW.id::text)<>1
  OR NOT EXISTS(SELECT 1 FROM outbox_event WHERE organization_id=NEW.organization_id AND type='EmployeeCompensationWithdrawn'
   AND idempotency_key='employee-compensation-submission:'||NEW.submission_id::text||':EmployeeCompensationWithdrawn' AND payload=jsonb_build_object('submissionId',NEW.submission_id::text))
 THEN RAISE EXCEPTION 'employee withdrawal requires its actual atomic attribution and event'; END IF;RETURN NEW;
END $$;

CREATE FUNCTION app_employee_run_claim_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended(NEW.organization_id::text||':employee-compensation-run:'||NEW.run_id::text,0));
 IF EXISTS(SELECT 1 FROM employee_compensation_submission s LEFT JOIN approval_request a ON a.organization_id=s.organization_id AND a.employee_submission_id=s.id
  WHERE s.organization_id=NEW.organization_id AND s.run_id=NEW.run_id AND COALESCE(a.state,'APPROVED')<>'REJECTED'
  AND NOT EXISTS(SELECT 1 FROM employee_compensation_withdrawal w WHERE w.organization_id=s.organization_id AND w.submission_id=s.id))
 THEN RAISE EXCEPTION 'withdraw active employee submissions before cancelling their original run'; END IF;RETURN NEW;
END $$;
CREATE TRIGGER employee_run_claim_guard BEFORE INSERT ON employee_compensation_run_cancellation FOR EACH ROW EXECUTE FUNCTION app_employee_run_claim_guard();

ALTER TABLE employee_compensation_submission ENABLE ROW LEVEL SECURITY;
ALTER TABLE employee_compensation_submission FORCE ROW LEVEL SECURITY;
CREATE POLICY employee_compensation_submission_tenant ON employee_compensation_submission USING(organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid) WITH CHECK(organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid);
CREATE TRIGGER employee_compensation_submission_immutable BEFORE UPDATE OR DELETE ON employee_compensation_submission FOR EACH ROW EXECUTE FUNCTION app_prevent_ledger_mutation();

ALTER TABLE employee_compensation_claim ENABLE ROW LEVEL SECURITY;
ALTER TABLE employee_compensation_claim FORCE ROW LEVEL SECURITY;
CREATE POLICY employee_compensation_claim_tenant ON employee_compensation_claim USING(organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid) WITH CHECK(organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid);
CREATE TRIGGER employee_compensation_claim_immutable BEFORE UPDATE OR DELETE ON employee_compensation_claim FOR EACH ROW EXECUTE FUNCTION app_prevent_ledger_mutation();

ALTER TABLE employee_compensation_cost ENABLE ROW LEVEL SECURITY;
ALTER TABLE employee_compensation_cost FORCE ROW LEVEL SECURITY;
CREATE POLICY employee_compensation_cost_tenant ON employee_compensation_cost USING(organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid) WITH CHECK(organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid);
CREATE TRIGGER employee_compensation_cost_immutable BEFORE UPDATE OR DELETE ON employee_compensation_cost FOR EACH ROW EXECUTE FUNCTION app_prevent_ledger_mutation();

ALTER TABLE employee_compensation_withdrawal ENABLE ROW LEVEL SECURITY;
ALTER TABLE employee_compensation_withdrawal FORCE ROW LEVEL SECURITY;
CREATE POLICY employee_compensation_withdrawal_tenant ON employee_compensation_withdrawal USING(organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid) WITH CHECK(organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid);
CREATE TRIGGER employee_compensation_withdrawal_immutable BEFORE UPDATE OR DELETE ON employee_compensation_withdrawal FOR EACH ROW EXECUTE FUNCTION app_prevent_ledger_mutation();
CREATE TRIGGER employee_compensation_claim_admission BEFORE INSERT ON employee_compensation_claim FOR EACH ROW EXECUTE FUNCTION app_employee_cost_admission();
CREATE TRIGGER employee_compensation_cost_admission BEFORE INSERT ON employee_compensation_cost FOR EACH ROW EXECUTE FUNCTION app_employee_cost_admission();
CREATE CONSTRAINT TRIGGER employee_submission_complete AFTER INSERT ON employee_compensation_submission DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app_employee_submission_complete();
CREATE CONSTRAINT TRIGGER employee_submission_complete AFTER INSERT ON employee_compensation_claim DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app_employee_submission_complete();
CREATE CONSTRAINT TRIGGER employee_submission_complete AFTER INSERT ON employee_compensation_cost DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app_employee_submission_complete();
CREATE CONSTRAINT TRIGGER employee_submission_complete AFTER INSERT ON approval_request DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app_employee_submission_complete();
CREATE CONSTRAINT TRIGGER employee_submission_complete AFTER INSERT ON approval_stage DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app_employee_submission_complete();
CREATE CONSTRAINT TRIGGER employee_submission_complete AFTER INSERT ON approval_stage_recipient DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app_employee_submission_complete();
CREATE CONSTRAINT TRIGGER employee_submission_complete AFTER INSERT ON approval_recipient DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app_employee_submission_complete();
CREATE CONSTRAINT TRIGGER employee_submission_complete AFTER INSERT ON audit_log DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app_employee_submission_complete();
CREATE CONSTRAINT TRIGGER employee_submission_complete AFTER INSERT ON outbox_event DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app_employee_submission_complete();
CREATE CONSTRAINT TRIGGER employee_withdrawal_complete AFTER INSERT ON employee_compensation_withdrawal DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app_employee_withdrawal_complete();

COMMIT;
