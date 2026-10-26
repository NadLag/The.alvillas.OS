-- AlterTable
ALTER TABLE "approval_request" ADD COLUMN     "expense_id" UUID;

-- CreateTable
CREATE TABLE "expense" (
    "id" UUID NOT NULL DEFAULT app_uuid_v7(),
    "organization_id" UUID NOT NULL,
    "property_id" UUID NOT NULL,
    "reservation_id" UUID,
    "funding_account_id" UUID NOT NULL,
    "transaction_id" UUID,
    "created_by" UUID NOT NULL,
    "updated_by" UUID NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "state" TEXT NOT NULL DEFAULT 'DRAFT',
    "amount" DECIMAL(18,2) NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "category" VARCHAR(120) NOT NULL,
    "purpose" VARCHAR(1000) NOT NULL,
    "occurred_on" DATE NOT NULL,
    "emergency" BOOLEAN NOT NULL DEFAULT false,
    "idempotency_key" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "expense_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "expense_submission" (
    "id" UUID NOT NULL DEFAULT app_uuid_v7(),
    "organization_id" UUID NOT NULL,
    "expense_id" UUID NOT NULL,
    "submitted_by" UUID NOT NULL,
    "snapshot" JSONB NOT NULL,
    "submitted_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "expense_submission_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "approval_stage" (
    "id" UUID NOT NULL DEFAULT app_uuid_v7(),
    "organization_id" UUID NOT NULL,
    "approval_id" UUID NOT NULL,
    "position" INTEGER NOT NULL,
    "kind" VARCHAR(120) NOT NULL,
    "owner_id" UUID,
    "amount" DECIMAL(18,2) NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'PENDING',
    "routing_snapshot" JSONB NOT NULL,
    "decided_by" UUID,
    "decision_reason" VARCHAR(500),
    "decided_at" TIMESTAMPTZ(6),

    CONSTRAINT "approval_stage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "approval_stage_recipient" (
    "id" UUID NOT NULL DEFAULT app_uuid_v7(),
    "organization_id" UUID NOT NULL,
    "stage_id" UUID NOT NULL,
    "user_account_id" UUID NOT NULL,

    CONSTRAINT "approval_stage_recipient_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "expense_organization_id_property_id_state_occurred_on_id_idx" ON "expense"("organization_id", "property_id", "state", "occurred_on", "id");

-- CreateIndex
CREATE UNIQUE INDEX "expense_organization_id_id_key" ON "expense"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "expense_organization_id_idempotency_key_key" ON "expense"("organization_id", "idempotency_key");

-- CreateIndex
CREATE UNIQUE INDEX "expense_organization_id_transaction_id_key" ON "expense"("organization_id", "transaction_id");

-- CreateIndex
CREATE UNIQUE INDEX "expense_submission_organization_id_id_key" ON "expense_submission"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "expense_submission_organization_id_expense_id_key" ON "expense_submission"("organization_id", "expense_id");

-- CreateIndex
CREATE UNIQUE INDEX "approval_stage_organization_id_id_key" ON "approval_stage"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "approval_stage_organization_id_approval_id_position_key" ON "approval_stage"("organization_id", "approval_id", "position");

-- CreateIndex
CREATE UNIQUE INDEX "approval_stage_recipient_organization_id_stage_id_user_acco_key" ON "approval_stage_recipient"("organization_id", "stage_id", "user_account_id");

-- CreateIndex
CREATE UNIQUE INDEX "owner_org_id_unique" ON "owner"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "approval_request_org_expense_unique" ON "approval_request"("organization_id", "expense_id");

-- AddForeignKey
ALTER TABLE "approval_request" ADD CONSTRAINT "approval_request_organization_id_expense_id_fkey" FOREIGN KEY ("organization_id", "expense_id") REFERENCES "expense"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "expense" ADD CONSTRAINT "expense_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "expense" ADD CONSTRAINT "expense_organization_id_property_id_fkey" FOREIGN KEY ("organization_id", "property_id") REFERENCES "property"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "expense" ADD CONSTRAINT "expense_organization_id_reservation_id_fkey" FOREIGN KEY ("organization_id", "reservation_id") REFERENCES "reservation"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "expense" ADD CONSTRAINT "expense_organization_id_funding_account_id_fkey" FOREIGN KEY ("organization_id", "funding_account_id") REFERENCES "ledger_account"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "expense" ADD CONSTRAINT "expense_organization_id_transaction_id_fkey" FOREIGN KEY ("organization_id", "transaction_id") REFERENCES "financial_transaction"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "expense" ADD CONSTRAINT "expense_organization_id_created_by_fkey" FOREIGN KEY ("organization_id", "created_by") REFERENCES "user_account"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "expense" ADD CONSTRAINT "expense_organization_id_updated_by_fkey" FOREIGN KEY ("organization_id", "updated_by") REFERENCES "user_account"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "expense" ADD CONSTRAINT "expense_currency_fkey" FOREIGN KEY ("currency") REFERENCES "currency"("code") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "expense_submission" ADD CONSTRAINT "expense_submission_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "expense_submission" ADD CONSTRAINT "expense_submission_organization_id_expense_id_fkey" FOREIGN KEY ("organization_id", "expense_id") REFERENCES "expense"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "expense_submission" ADD CONSTRAINT "expense_submission_organization_id_submitted_by_fkey" FOREIGN KEY ("organization_id", "submitted_by") REFERENCES "user_account"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "approval_stage" ADD CONSTRAINT "approval_stage_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "approval_stage" ADD CONSTRAINT "approval_stage_organization_id_approval_id_fkey" FOREIGN KEY ("organization_id", "approval_id") REFERENCES "approval_request"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "approval_stage" ADD CONSTRAINT "approval_stage_organization_id_owner_id_fkey" FOREIGN KEY ("organization_id", "owner_id") REFERENCES "owner"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "approval_stage" ADD CONSTRAINT "approval_stage_organization_id_decided_by_fkey" FOREIGN KEY ("organization_id", "decided_by") REFERENCES "user_account"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "approval_stage" ADD CONSTRAINT "approval_stage_currency_fkey" FOREIGN KEY ("currency") REFERENCES "currency"("code") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "approval_stage_recipient" ADD CONSTRAINT "approval_stage_recipient_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "approval_stage_recipient" ADD CONSTRAINT "approval_stage_recipient_organization_id_stage_id_fkey" FOREIGN KEY ("organization_id", "stage_id") REFERENCES "approval_stage"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "approval_stage_recipient" ADD CONSTRAINT "approval_stage_recipient_organization_id_user_account_id_fkey" FOREIGN KEY ("organization_id", "user_account_id") REFERENCES "user_account"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

ALTER TABLE expense ENABLE ROW LEVEL SECURITY;
ALTER TABLE expense FORCE ROW LEVEL SECURITY;
CREATE POLICY expense_tenant_isolation ON expense
 USING (organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid)
 WITH CHECK (organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid);
ALTER TABLE expense_submission ENABLE ROW LEVEL SECURITY;
ALTER TABLE expense_submission FORCE ROW LEVEL SECURITY;
CREATE POLICY expense_submission_tenant_isolation ON expense_submission
 USING (organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid)
 WITH CHECK (organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid);
ALTER TABLE approval_stage ENABLE ROW LEVEL SECURITY;
ALTER TABLE approval_stage FORCE ROW LEVEL SECURITY;
CREATE POLICY approval_stage_tenant_isolation ON approval_stage
 USING (organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid)
 WITH CHECK (organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid);
ALTER TABLE approval_stage_recipient ENABLE ROW LEVEL SECURITY;
ALTER TABLE approval_stage_recipient FORCE ROW LEVEL SECURITY;
CREATE POLICY approval_stage_recipient_tenant_isolation ON approval_stage_recipient
 USING (organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid)
 WITH CHECK (organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid);

ALTER TABLE expense ADD CONSTRAINT expense_positive_amount CHECK (amount>0);
ALTER TABLE expense ADD CONSTRAINT expense_positive_version CHECK (version>0);
ALTER TABLE approval_stage ADD CONSTRAINT approval_stage_positive_amount CHECK (amount>0);
ALTER TABLE approval_stage ADD CONSTRAINT approval_stage_positive_position CHECK (position>0);

CREATE TRIGGER expense_submission_no_update BEFORE UPDATE OR DELETE ON expense_submission
 FOR EACH ROW EXECUTE FUNCTION app_prevent_ledger_mutation();
CREATE TRIGGER approval_stage_recipient_no_update BEFORE UPDATE OR DELETE ON approval_stage_recipient
 FOR EACH ROW EXECUTE FUNCTION app_prevent_ledger_mutation();

CREATE FUNCTION app_expense_state_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'expenses cannot be deleted'; END IF;
 IF TG_OP='INSERT' THEN
  IF NEW.state<>'DRAFT' OR NEW.version<>1 OR NEW.transaction_id IS NOT NULL THEN RAISE EXCEPTION 'expenses start as unposted drafts'; END IF;
 ELSE
  IF ROW(NEW.organization_id,NEW.id,NEW.created_by,NEW.idempotency_key,NEW.created_at)
    IS DISTINCT FROM ROW(OLD.organization_id,OLD.id,OLD.created_by,OLD.idempotency_key,OLD.created_at)
    OR NEW.version<>OLD.version+1 THEN RAISE EXCEPTION 'expense identity and version are immutable'; END IF;
  IF OLD.state<>'DRAFT' AND ROW(NEW.property_id,NEW.reservation_id,NEW.funding_account_id,NEW.amount,NEW.currency,NEW.category,NEW.purpose,NEW.occurred_on,NEW.emergency)
    IS DISTINCT FROM ROW(OLD.property_id,OLD.reservation_id,OLD.funding_account_id,OLD.amount,OLD.currency,OLD.category,OLD.purpose,OLD.occurred_on,OLD.emergency)
  THEN RAISE EXCEPTION 'submitted expense facts are immutable'; END IF;
  IF NOT ((OLD.state='DRAFT' AND NEW.state IN ('DRAFT','PENDING_APPROVAL')) OR
    (OLD.state='PENDING_APPROVAL' AND NEW.state IN ('APPROVED','REJECTED')) OR
    (OLD.state='APPROVED' AND NEW.state='POSTED') OR (OLD.state='POSTED' AND NEW.state='VOIDED'))
  THEN RAISE EXCEPTION 'invalid expense state transition'; END IF;
  IF OLD.transaction_id IS NOT NULL AND NEW.transaction_id IS DISTINCT FROM OLD.transaction_id THEN RAISE EXCEPTION 'expense original journal is immutable'; END IF;
 END IF;
 IF (NEW.state IN ('POSTED','VOIDED')) IS DISTINCT FROM (NEW.transaction_id IS NOT NULL) THEN RAISE EXCEPTION 'expense posting state and journal must agree'; END IF;
 IF NOT EXISTS (SELECT 1 FROM currency WHERE code=NEW.currency AND minor_unit<=2 AND NEW.amount=round(NEW.amount,minor_unit))
 THEN RAISE EXCEPTION 'expense currency precision is invalid'; END IF;
 IF NEW.reservation_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM reservation WHERE organization_id=NEW.organization_id AND id=NEW.reservation_id AND property_id=NEW.property_id)
 THEN RAISE EXCEPTION 'expense reservation and property must agree'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER expense_state_guard BEFORE INSERT OR UPDATE OR DELETE ON expense
 FOR EACH ROW EXECUTE FUNCTION app_expense_state_guard();

CREATE FUNCTION app_financial_approval_stage_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'financial approval stages cannot be deleted'; END IF;
 IF TG_OP='INSERT' THEN
  IF NEW.state<>'PENDING' OR NEW.decided_by IS NOT NULL OR NEW.decided_at IS NOT NULL OR NEW.decision_reason IS NOT NULL THEN RAISE EXCEPTION 'approval stages start pending'; END IF;
  IF NOT EXISTS (SELECT 1 FROM approval_request a JOIN expense e ON e.organization_id=a.organization_id AND e.id=a.expense_id
    WHERE a.organization_id=NEW.organization_id AND a.id=NEW.approval_id AND e.state='PENDING_APPROVAL' AND e.currency=NEW.currency)
  THEN RAISE EXCEPTION 'financial approval stage requires its submitted expense'; END IF;
 ELSE
  IF ROW(NEW.organization_id,NEW.id,NEW.approval_id,NEW.position,NEW.kind,NEW.owner_id,NEW.amount,NEW.currency,NEW.routing_snapshot)
   IS DISTINCT FROM ROW(OLD.organization_id,OLD.id,OLD.approval_id,OLD.position,OLD.kind,OLD.owner_id,OLD.amount,OLD.currency,OLD.routing_snapshot)
   OR OLD.state<>'PENDING' OR NEW.state NOT IN ('APPROVED','REJECTED','CANCELLED')
   OR NEW.decided_by IS NULL OR NEW.decided_at IS NULL OR NEW.decision_reason IS NULL OR length(trim(NEW.decision_reason))<6
  THEN RAISE EXCEPTION 'financial approval decisions are immutable and require attribution'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER financial_approval_stage_guard BEFORE INSERT OR UPDATE OR DELETE ON approval_stage
 FOR EACH ROW EXECUTE FUNCTION app_financial_approval_stage_guard();

