BEGIN;

-- Additive native owner payouts; existing financial rows and applied migrations remain unchanged.
-- AlterTable
ALTER TABLE "approval_request" ADD COLUMN     "payout_id" UUID;

-- CreateTable
CREATE TABLE "owner_payout" (
    "id" UUID NOT NULL DEFAULT app_uuid_v7(),
    "organization_id" UUID NOT NULL,
    "property_id" UUID NOT NULL,
    "owner_id" UUID NOT NULL,
    "reservation_id" UUID,
    "payout_method_id" UUID NOT NULL,
    "funding_account_id" UUID NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "purpose" VARCHAR(500) NOT NULL,
    "state" VARCHAR(40) NOT NULL DEFAULT 'DRAFT',
    "version" INTEGER NOT NULL DEFAULT 1,
    "idempotency_key" UUID NOT NULL,
    "policy_snapshot" JSONB,
    "method_snapshot_hash" VARCHAR(64),
    "eligible_at" TIMESTAMPTZ(6),
    "approved_at" TIMESTAMPTZ(6),
    "scheduled_for" TIMESTAMPTZ(6),
    "paid_at" TIMESTAMPTZ(6),
    "payment_reference" VARCHAR(160),
    "transaction_id" UUID,
    "reversal_transaction_id" UUID,
    "reconciled_at" TIMESTAMPTZ(6),
    "failure_reason" VARCHAR(500),
    "created_by" UUID NOT NULL,
    "updated_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "owner_payout_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "owner_payout_organization_id_owner_id_property_id_currency__idx" ON "owner_payout"("organization_id", "owner_id", "property_id", "currency", "state", "created_at");

-- CreateIndex
CREATE INDEX "owner_payout_organization_id_state_scheduled_for_id_idx" ON "owner_payout"("organization_id", "state", "scheduled_for", "id");

-- CreateIndex
CREATE UNIQUE INDEX "owner_payout_organization_id_id_key" ON "owner_payout"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "owner_payout_organization_id_idempotency_key_key" ON "owner_payout"("organization_id", "idempotency_key");

-- CreateIndex
CREATE UNIQUE INDEX "owner_payout_organization_id_transaction_id_key" ON "owner_payout"("organization_id", "transaction_id");

-- CreateIndex
CREATE UNIQUE INDEX "owner_payout_organization_id_reversal_transaction_id_key" ON "owner_payout"("organization_id", "reversal_transaction_id");

-- CreateIndex
CREATE UNIQUE INDEX "owner_payout_method_org_id_unique" ON "owner_payout_method"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "approval_request_org_payout_unique" ON "approval_request"("organization_id", "payout_id");

-- AddForeignKey
ALTER TABLE "approval_request" ADD CONSTRAINT "approval_request_organization_id_payout_id_fkey" FOREIGN KEY ("organization_id", "payout_id") REFERENCES "owner_payout"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "owner_payout" ADD CONSTRAINT "owner_payout_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "owner_payout" ADD CONSTRAINT "owner_payout_organization_id_property_id_fkey" FOREIGN KEY ("organization_id", "property_id") REFERENCES "property"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "owner_payout" ADD CONSTRAINT "owner_payout_organization_id_owner_id_fkey" FOREIGN KEY ("organization_id", "owner_id") REFERENCES "owner"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "owner_payout" ADD CONSTRAINT "owner_payout_organization_id_reservation_id_fkey" FOREIGN KEY ("organization_id", "reservation_id") REFERENCES "reservation"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "owner_payout" ADD CONSTRAINT "owner_payout_organization_id_payout_method_id_fkey" FOREIGN KEY ("organization_id", "payout_method_id") REFERENCES "owner_payout_method"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "owner_payout" ADD CONSTRAINT "owner_payout_organization_id_funding_account_id_fkey" FOREIGN KEY ("organization_id", "funding_account_id") REFERENCES "ledger_account"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "owner_payout" ADD CONSTRAINT "owner_payout_currency_fkey" FOREIGN KEY ("currency") REFERENCES "currency"("code") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "owner_payout" ADD CONSTRAINT "owner_payout_organization_id_created_by_fkey" FOREIGN KEY ("organization_id", "created_by") REFERENCES "user_account"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "owner_payout" ADD CONSTRAINT "owner_payout_organization_id_updated_by_fkey" FOREIGN KEY ("organization_id", "updated_by") REFERENCES "user_account"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "owner_payout" ADD CONSTRAINT "owner_payout_organization_id_transaction_id_fkey" FOREIGN KEY ("organization_id", "transaction_id") REFERENCES "financial_transaction"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "owner_payout" ADD CONSTRAINT "owner_payout_organization_id_reversal_transaction_id_fkey" FOREIGN KEY ("organization_id", "reversal_transaction_id") REFERENCES "financial_transaction"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;


ALTER TABLE owner_payout ADD CONSTRAINT owner_payout_amount_positive CHECK(amount>0),
 ADD CONSTRAINT owner_payout_version_positive CHECK(version>0),
 ADD CONSTRAINT owner_payout_purpose_length CHECK(length(btrim(purpose)) BETWEEN 3 AND 500),
 ADD CONSTRAINT owner_payout_state_valid CHECK(state IN('DRAFT','PENDING_APPROVAL','APPROVED','SCHEDULED','PAID','RECONCILED','FAILED','CANCELLED'));
ALTER TABLE approval_request ADD CONSTRAINT approval_request_one_financial_subject CHECK(expense_id IS NULL OR payout_id IS NULL);
ALTER TABLE owner_payout ENABLE ROW LEVEL SECURITY;
ALTER TABLE owner_payout FORCE ROW LEVEL SECURITY;
CREATE POLICY owner_payout_tenant_isolation ON owner_payout
 USING(organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid)
 WITH CHECK(organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid);

CREATE FUNCTION app_owner_payout_state_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'owner payout history cannot be deleted'; END IF;
 IF TG_OP='INSERT' THEN
  IF NEW.state<>'DRAFT' OR NEW.version<>1 OR NEW.policy_snapshot IS NOT NULL OR NEW.method_snapshot_hash IS NOT NULL
   OR NEW.eligible_at IS NOT NULL OR NEW.approved_at IS NOT NULL OR NEW.scheduled_for IS NOT NULL OR NEW.paid_at IS NOT NULL
   OR NEW.payment_reference IS NOT NULL OR NEW.transaction_id IS NOT NULL OR NEW.reversal_transaction_id IS NOT NULL
   OR NEW.reconciled_at IS NOT NULL OR NEW.failure_reason IS NOT NULL OR NEW.created_by<>NEW.updated_by
  THEN RAISE EXCEPTION 'owner payout must begin as an attributed draft'; END IF;
 ELSE
  IF ROW(NEW.id,NEW.organization_id,NEW.idempotency_key,NEW.created_by,NEW.created_at)
   IS DISTINCT FROM ROW(OLD.id,OLD.organization_id,OLD.idempotency_key,OLD.created_by,OLD.created_at) OR NEW.version<>OLD.version+1
  THEN RAISE EXCEPTION 'owner payout identity and history are immutable'; END IF;
  IF ROW(NEW.policy_snapshot,NEW.method_snapshot_hash,NEW.eligible_at) IS DISTINCT FROM ROW(OLD.policy_snapshot,OLD.method_snapshot_hash,OLD.eligible_at)
   AND NOT(OLD.state='DRAFT' AND NEW.state='PENDING_APPROVAL')
   OR NEW.approved_at IS DISTINCT FROM OLD.approved_at AND NOT(OLD.state='PENDING_APPROVAL' AND NEW.state='APPROVED')
   OR NEW.scheduled_for IS DISTINCT FROM OLD.scheduled_for AND NOT(OLD.state='APPROVED' AND NEW.state='SCHEDULED')
   OR ROW(NEW.transaction_id,NEW.paid_at,NEW.payment_reference) IS DISTINCT FROM ROW(OLD.transaction_id,OLD.paid_at,OLD.payment_reference)
    AND NOT(OLD.state='SCHEDULED' AND NEW.state='PAID')
   OR NEW.reversal_transaction_id IS DISTINCT FROM OLD.reversal_transaction_id AND NOT(OLD.state='PAID' AND NEW.state='CANCELLED')
   OR NEW.failure_reason IS DISTINCT FROM OLD.failure_reason AND NOT(OLD.state='SCHEDULED' AND NEW.state='FAILED')
   OR NEW.reconciled_at IS DISTINCT FROM OLD.reconciled_at AND NOT(OLD.state='PAID' AND NEW.state='RECONCILED')
  THEN RAISE EXCEPTION 'owner payout effect evidence belongs to its exact lifecycle transition'; END IF;
  IF NOT ((OLD.state='DRAFT' AND NEW.state IN('DRAFT','PENDING_APPROVAL','CANCELLED'))
   OR (OLD.state='PENDING_APPROVAL' AND NEW.state IN('APPROVED','CANCELLED'))
   OR (OLD.state='APPROVED' AND NEW.state IN('SCHEDULED','CANCELLED'))
   OR (OLD.state='SCHEDULED' AND NEW.state IN('PAID','FAILED','CANCELLED'))
   OR (OLD.state='PAID' AND NEW.state IN('RECONCILED','CANCELLED')))
  THEN RAISE EXCEPTION 'owner payout cannot skip or rewrite its lifecycle'; END IF;
  IF OLD.state<>'DRAFT' AND ROW(NEW.property_id,NEW.owner_id,NEW.reservation_id,NEW.payout_method_id,NEW.funding_account_id,
    NEW.amount,NEW.currency,NEW.purpose,NEW.policy_snapshot,NEW.method_snapshot_hash,NEW.eligible_at)
   IS DISTINCT FROM ROW(OLD.property_id,OLD.owner_id,OLD.reservation_id,OLD.payout_method_id,OLD.funding_account_id,
    OLD.amount,OLD.currency,OLD.purpose,OLD.policy_snapshot,OLD.method_snapshot_hash,OLD.eligible_at)
  THEN RAISE EXCEPTION 'submitted payout terms and source amounts are immutable'; END IF;
  IF OLD.approved_at IS NOT NULL AND NEW.approved_at IS DISTINCT FROM OLD.approved_at
   OR OLD.scheduled_for IS NOT NULL AND NEW.scheduled_for IS DISTINCT FROM OLD.scheduled_for
   OR OLD.transaction_id IS NOT NULL AND ROW(NEW.transaction_id,NEW.paid_at,NEW.payment_reference) IS DISTINCT FROM ROW(OLD.transaction_id,OLD.paid_at,OLD.payment_reference)
  THEN RAISE EXCEPTION 'owner payout approval, schedule and original payment are immutable'; END IF;
 END IF;
 IF NEW.state IN('DRAFT','PENDING_APPROVAL','PAID') THEN
  IF NOT EXISTS(SELECT 1 FROM owner_payout_method m WHERE m.organization_id=NEW.organization_id AND m.id=NEW.payout_method_id
    AND m.owner_id=NEW.owner_id AND m.currency=NEW.currency AND m.status='ACTIVE' AND m.archived_at IS NULL)
   OR NOT EXISTS(SELECT 1 FROM ledger_account a WHERE a.organization_id=NEW.organization_id AND a.id=NEW.funding_account_id
    AND a.archived_at IS NULL AND a.normal_side='DEBIT' AND position('CASH_CUSTODY_' in a.code)<>1
    AND (a.account_type IN('ASSET','ASSET_LOCATION') OR a.account_type='STAFF_WALLET' AND EXISTS(
     SELECT 1 FROM team_wallet w JOIN person p ON p.organization_id=w.organization_id AND p.id=w.person_id
     WHERE w.organization_id=a.organization_id AND w.ledger_account_id=a.id AND p.archived_at IS NULL)))
  THEN RAISE EXCEPTION 'owner payout recipient and funding source must be valid and tenant scoped'; END IF;
 END IF;
 IF NEW.state IN('PENDING_APPROVAL','APPROVED','SCHEDULED','PAID','RECONCILED','FAILED') AND
  (NEW.policy_snapshot IS NULL OR NEW.method_snapshot_hash IS NULL OR NEW.method_snapshot_hash !~ '^[0-9a-f]{64}$' OR NEW.eligible_at IS NULL)
 THEN RAISE EXCEPTION 'owner payout requires its frozen effective terms'; END IF;
 IF NEW.state IN('APPROVED','SCHEDULED','PAID','RECONCILED','FAILED') AND NEW.approved_at IS NULL
 THEN RAISE EXCEPTION 'owner payout requires an attributed approval time'; END IF;
 IF NEW.state IN('SCHEDULED','PAID','RECONCILED','FAILED') AND (NEW.scheduled_for IS NULL OR NEW.scheduled_for<NEW.eligible_at)
 THEN RAISE EXCEPTION 'owner payout cannot be scheduled before its configured eligibility'; END IF;
 IF NEW.state IN('PAID','RECONCILED') AND (NEW.transaction_id IS NULL OR NEW.paid_at IS NULL OR length(btrim(COALESCE(NEW.payment_reference,''))) NOT BETWEEN 3 AND 160 OR NEW.paid_at<NEW.scheduled_for)
 THEN RAISE EXCEPTION 'owner payout payment requires its due schedule, journal and bank reference'; END IF;
 IF TG_OP='UPDATE' AND OLD.state='SCHEDULED' AND NEW.state='PAID' AND
  (NEW.paid_at<date_trunc('milliseconds',transaction_timestamp()) OR NEW.paid_at>clock_timestamp())
 THEN RAISE EXCEPTION 'owner payout must record its new payment at the current posting time'; END IF;
 IF TG_OP='UPDATE' AND OLD.state='PAID' AND NEW.state='CANCELLED' AND NEW.reversal_transaction_id IS NULL
 THEN RAISE EXCEPTION 'paid owner payout cancellation requires its exact reversal'; END IF;
 IF NEW.state='FAILED' AND length(btrim(COALESCE(NEW.failure_reason,''))) NOT BETWEEN 6 AND 500
 THEN RAISE EXCEPTION 'owner payout failure requires its reason'; END IF;
 IF NEW.state='RECONCILED' AND NEW.reconciled_at IS NULL THEN RAISE EXCEPTION 'owner payout reconciliation requires its time'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER owner_payout_state_guard BEFORE INSERT OR UPDATE OR DELETE ON owner_payout
 FOR EACH ROW EXECUTE FUNCTION app_owner_payout_state_guard();

CREATE FUNCTION app_assert_owner_payout(payout_uuid uuid,organization_uuid uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE p owner_payout%ROWTYPE; a approval_request%ROWTYPE; s approval_stage%ROWTYPE; expected jsonb;
 expected_recipients text[]; actual_recipients text[]; stage_count integer; journal financial_transaction%ROWTYPE;
BEGIN
 SELECT * INTO p FROM owner_payout WHERE organization_id=organization_uuid AND id=payout_uuid;
 IF NOT FOUND THEN RAISE EXCEPTION 'owner payout source is unavailable'; END IF;
 IF p.policy_snapshot IS NULL THEN
  IF p.state NOT IN('DRAFT','CANCELLED') OR p.transaction_id IS NOT NULL OR EXISTS(SELECT 1 FROM approval_request WHERE organization_id=p.organization_id AND payout_id=p.id)
  THEN RAISE EXCEPTION 'unsubmitted owner payout cannot have financial effects'; END IF;
  RETURN;
 END IF;
 IF jsonb_typeof(p.policy_snapshot->'stages') IS DISTINCT FROM 'array'
  OR p.policy_snapshot->>'ownerId' IS DISTINCT FROM p.owner_id::text OR p.policy_snapshot->>'propertyId' IS DISTINCT FROM p.property_id::text
  OR p.policy_snapshot->>'fundingAccountId' IS DISTINCT FROM p.funding_account_id::text
  OR p.policy_snapshot->>'payoutMethodId' IS DISTINCT FROM p.payout_method_id::text
  OR p.policy_snapshot->>'methodSnapshotHash' IS DISTINCT FROM p.method_snapshot_hash
  OR p.policy_snapshot->'amount'->>'currency' IS DISTINCT FROM p.currency::text
  OR (p.policy_snapshot->'amount'->>'amount')::numeric IS DISTINCT FROM p.amount
  OR p.policy_snapshot->'payout'->'payableAmount'->>'currency' IS DISTINCT FROM p.currency::text
  OR p.policy_snapshot->'payout'->'payableAmount'->>'amount' IS NULL
  OR p.amount>(p.policy_snapshot->'payout'->'payableAmount'->>'amount')::numeric
 THEN RAISE EXCEPTION 'owner payout must retain its exact submitted amount and configured plan'; END IF;
 stage_count:=jsonb_array_length(p.policy_snapshot->'stages');
 SELECT * INTO a FROM approval_request WHERE organization_id=p.organization_id AND payout_id=p.id;
 IF stage_count=0 THEN
  IF a.id IS NOT NULL OR p.state='PENDING_APPROVAL' THEN RAISE EXCEPTION 'configured automatic approval must finish atomically'; END IF;
 ELSE
  IF a.id IS NULL OR a.expense_id IS NOT NULL OR a.property_id<>p.property_id OR a.requested_by::text IS DISTINCT FROM p.policy_snapshot->>'submittedBy'
   OR (SELECT count(*) FROM approval_stage WHERE organization_id=p.organization_id AND approval_id=a.id)<>stage_count
  THEN RAISE EXCEPTION 'owner payout requires its exact configured approval chain'; END IF;
  FOR s IN SELECT * FROM approval_stage WHERE organization_id=p.organization_id AND approval_id=a.id ORDER BY position LOOP
   expected:=p.policy_snapshot->'stages'->(s.position-1);
   IF expected IS NULL OR s.kind IS DISTINCT FROM expected->>'kind' OR s.owner_id IS DISTINCT FROM p.owner_id OR s.amount<>p.amount OR s.currency<>p.currency
    OR s.routing_snapshot IS DISTINCT FROM expected->'routing' THEN RAISE EXCEPTION 'owner payout approval stage differs from its frozen policy'; END IF;
   SELECT array_agg(value ORDER BY value) INTO expected_recipients FROM jsonb_array_elements_text(expected->'recipients');
   SELECT array_agg(user_account_id::text ORDER BY user_account_id::text) INTO actual_recipients FROM approval_stage_recipient WHERE organization_id=p.organization_id AND stage_id=s.id;
   IF expected_recipients IS NULL OR expected_recipients IS DISTINCT FROM actual_recipients THEN RAISE EXCEPTION 'owner payout recipients differ from their frozen policy'; END IF;
   IF s.state IN('APPROVED','REJECTED') AND NOT EXISTS(SELECT 1 FROM audit_log l WHERE l.organization_id=p.organization_id AND l.resource_type='owner_payout'
    AND l.resource_id=p.id AND l.action='finance.owner_payout.approval_stage_decided' AND l.actor_id=s.decided_by
    AND l.after->>'stageId'=s.id::text AND l.after->>'state'=s.state)
   THEN RAISE EXCEPTION 'owner payout stage decision requires its atomic audit'; END IF;
  END LOOP;
  IF p.state IN('APPROVED','SCHEDULED','PAID','RECONCILED','FAILED') OR p.transaction_id IS NOT NULL THEN
   IF a.state<>'APPROVED' OR EXISTS(SELECT 1 FROM approval_stage WHERE organization_id=p.organization_id AND approval_id=a.id AND state<>'APPROVED')
   THEN RAISE EXCEPTION 'owner payout cannot bypass a configured approval'; END IF;
  ELSIF p.state='PENDING_APPROVAL' AND (a.state<>'PENDING' OR NOT EXISTS(SELECT 1 FROM approval_stage WHERE organization_id=p.organization_id AND approval_id=a.id AND state='PENDING'))
   OR p.state='CANCELLED' AND (a.state NOT IN('CANCELLED','REJECTED') OR EXISTS(SELECT 1 FROM approval_stage WHERE organization_id=p.organization_id AND approval_id=a.id AND state='PENDING'))
  THEN RAISE EXCEPTION 'owner payout and approval state must agree'; END IF;
 END IF;
 IF p.transaction_id IS NOT NULL THEN
  SELECT * INTO journal FROM financial_transaction WHERE organization_id=p.organization_id AND id=p.transaction_id;
  IF journal.id IS NULL OR p.state NOT IN('PAID','RECONCILED','CANCELLED') OR journal.reference IS DISTINCT FROM 'PAYOUT:'||p.id::text
   OR journal.idempotency_key IS DISTINCT FROM 'payout:'||p.id::text||':paid' OR journal.reverses_transaction_id IS NOT NULL
   OR journal.occurred_at IS DISTINCT FROM p.paid_at OR journal.description IS DISTINCT FROM p.purpose
   OR NOT EXISTS(SELECT 1 FROM audit_log proof WHERE proof.organization_id=p.organization_id AND proof.resource_type='owner_payout'
    AND proof.resource_id=p.id AND proof.action='finance.owner_payout.paid' AND proof.actor_id=journal.created_by
    AND proof.after->>'transactionId'=journal.id::text AND proof.after->>'state'='PAID' AND length(btrim(COALESCE(proof.reason,''))) BETWEEN 6 AND 500)
   OR (SELECT count(*) FROM posting WHERE organization_id=p.organization_id AND transaction_id=journal.id)<>2
   OR NOT EXISTS(SELECT 1 FROM posting line JOIN ledger_account claim ON claim.organization_id=line.organization_id AND claim.id=line.ledger_account_id
    WHERE line.organization_id=p.organization_id AND line.transaction_id=journal.id AND claim.code='OWNER_PAYABLE' AND claim.account_type='CLAIM_OWNERSHIP'
    AND line.side='DEBIT' AND line.amount=p.amount AND line.currency=p.currency AND line.bucket='PAYOUT'
    AND line.dimensions @> jsonb_build_object('source','OWNER_PAYOUT','payout_id',p.id::text,'owner_id',p.owner_id::text,'property_id',p.property_id::text))
   OR NOT EXISTS(SELECT 1 FROM posting line WHERE line.organization_id=p.organization_id AND line.transaction_id=journal.id
    AND line.ledger_account_id=p.funding_account_id AND line.side='CREDIT' AND line.amount=p.amount AND line.currency=p.currency AND line.bucket='PAYOUT_PAYMENT'
    AND line.dimensions @> jsonb_build_object('source','OWNER_PAYOUT','payout_id',p.id::text,'owner_id',p.owner_id::text,'property_id',p.property_id::text))
  THEN RAISE EXCEPTION 'owner payout requires its exact atomic ownership and funding journal'; END IF;
  IF p.state='CANCELLED' AND (p.reversal_transaction_id IS NULL OR NOT EXISTS(SELECT 1 FROM financial_transaction r WHERE r.organization_id=p.organization_id AND r.id=p.reversal_transaction_id AND r.reverses_transaction_id=p.transaction_id))
   OR p.state<>'CANCELLED' AND EXISTS(SELECT 1 FROM financial_transaction r WHERE r.organization_id=p.organization_id AND r.reverses_transaction_id=p.transaction_id)
  THEN RAISE EXCEPTION 'owner payout reversal must update its source lifecycle atomically'; END IF;
 END IF;
END $$;

CREATE FUNCTION app_owner_payout_audit_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE required_action text;
BEGIN
 required_action:=CASE WHEN TG_OP='INSERT' THEN 'finance.owner_payout.created'
  WHEN NEW.state='DRAFT' THEN 'finance.owner_payout.edited' WHEN NEW.state='PENDING_APPROVAL' THEN 'finance.owner_payout.submitted'
  WHEN NEW.state='APPROVED' THEN 'finance.owner_payout.approved' WHEN NEW.state='SCHEDULED' THEN 'finance.owner_payout.scheduled'
  WHEN NEW.state='PAID' THEN 'finance.owner_payout.paid' WHEN NEW.state='FAILED' THEN 'finance.owner_payout.failed'
  WHEN NEW.state='RECONCILED' THEN 'finance.owner_payout.reconciled' WHEN OLD.state='PAID' AND NEW.state='CANCELLED' THEN 'finance.owner_payout.reversed'
  ELSE 'finance.owner_payout.cancelled' END;
 IF NOT EXISTS(SELECT 1 FROM audit_log l WHERE l.organization_id=NEW.organization_id AND l.resource_type='owner_payout' AND l.resource_id=NEW.id
  AND l.action=required_action AND l.actor_id=NEW.updated_by AND l.property_scope_id=NEW.property_id
  AND length(btrim(COALESCE(l.reason,''))) BETWEEN 6 AND 500 AND l.after->>'payoutId'=NEW.id::text
  AND (l.after->>'version')::integer=NEW.version AND l.after->>'state'=NEW.state
  AND (TG_OP<>'INSERT' OR (l.after->'request'->>'ownerId'=NEW.owner_id::text
   AND l.after->'request'->>'propertyId'=NEW.property_id::text AND l.after->'request'->>'fundingAccountId'=NEW.funding_account_id::text
   AND l.after->'request'->>'payoutMethodId'=NEW.payout_method_id::text AND l.after->'request'->>'currency'=NEW.currency::text
   AND (l.after->'request'->>'amount')::numeric=NEW.amount AND l.after->'request'->>'purpose'=NEW.purpose
   AND l.after->'request'->>'idempotencyKey'=NEW.idempotency_key::text AND l.after->'request'->>'reason'=l.reason))
  AND (TG_OP='INSERT' OR (l.before->>'version')::integer=OLD.version))
 THEN RAISE EXCEPTION 'owner payout transition requires its complete attributed audit'; END IF;
 PERFORM app_assert_owner_payout(NEW.id,NEW.organization_id);
 RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER owner_payout_audit_guard AFTER INSERT OR UPDATE ON owner_payout
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app_owner_payout_audit_guard();

CREATE FUNCTION app_owner_payout_approval_header_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE p owner_payout%ROWTYPE;
BEGIN
 IF TG_OP='DELETE' THEN IF OLD.payout_id IS NOT NULL THEN RAISE EXCEPTION 'owner payout approval history cannot be deleted'; END IF; RETURN OLD; END IF;
 IF TG_OP='UPDATE' AND (OLD.payout_id IS NOT NULL OR NEW.payout_id IS NOT NULL) AND
  ROW(NEW.id,NEW.organization_id,NEW.payout_id,NEW.property_id,NEW.requested_by,NEW.title,NEW.details,NEW.routing_snapshot,NEW.idempotency_key,NEW.created_at)
  IS DISTINCT FROM ROW(OLD.id,OLD.organization_id,OLD.payout_id,OLD.property_id,OLD.requested_by,OLD.title,OLD.details,OLD.routing_snapshot,OLD.idempotency_key,OLD.created_at)
 THEN RAISE EXCEPTION 'owner payout approval source is immutable'; END IF;
 IF NEW.payout_id IS NULL THEN RETURN NEW; END IF;
 SELECT * INTO p FROM owner_payout WHERE organization_id=NEW.organization_id AND id=NEW.payout_id;
 IF NOT FOUND OR p.property_id<>NEW.property_id OR p.policy_snapshot->>'submittedBy' IS DISTINCT FROM NEW.requested_by::text
 THEN RAISE EXCEPTION 'owner payout approval requires its original submission'; END IF;
 IF TG_OP='INSERT' AND (NEW.state<>'PENDING' OR p.state<>'PENDING_APPROVAL' OR NEW.decided_by IS NOT NULL OR NEW.decided_at IS NOT NULL OR NEW.decision_reason IS NOT NULL)
  OR TG_OP='UPDATE' AND (OLD.state<>'PENDING' OR NEW.state NOT IN('APPROVED','REJECTED','CANCELLED') OR NEW.decided_by IS NULL OR NEW.decided_at IS NULL OR length(btrim(COALESCE(NEW.decision_reason,''))) NOT BETWEEN 6 AND 500)
 THEN RAISE EXCEPTION 'owner payout approval requires ordered, immutable attribution'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER owner_payout_approval_header_guard BEFORE INSERT OR UPDATE OR DELETE ON approval_request
 FOR EACH ROW EXECUTE FUNCTION app_owner_payout_approval_header_guard();

CREATE FUNCTION app_owner_payout_related_integrity_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE approval_uuid uuid; payout_uuid uuid;
BEGIN
 IF TG_TABLE_NAME='approval_request' THEN approval_uuid:=NEW.id;
 ELSIF TG_TABLE_NAME='approval_stage' THEN approval_uuid:=NEW.approval_id;
 ELSE SELECT approval_id INTO approval_uuid FROM approval_stage WHERE organization_id=NEW.organization_id AND id=NEW.stage_id; END IF;
 SELECT payout_id INTO payout_uuid FROM approval_request WHERE organization_id=NEW.organization_id AND id=approval_uuid;
 IF payout_uuid IS NOT NULL THEN PERFORM app_assert_owner_payout(payout_uuid,NEW.organization_id); END IF;
 RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER owner_payout_approval_integrity_guard AFTER INSERT OR UPDATE ON approval_request
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app_owner_payout_related_integrity_guard();
CREATE CONSTRAINT TRIGGER owner_payout_stage_integrity_guard AFTER INSERT OR UPDATE ON approval_stage
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app_owner_payout_related_integrity_guard();
CREATE CONSTRAINT TRIGGER owner_payout_recipient_integrity_guard AFTER INSERT ON approval_stage_recipient
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app_owner_payout_related_integrity_guard();

CREATE FUNCTION app_owner_payout_journal_integrity_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE payout_uuid uuid;
BEGIN
 SELECT id INTO payout_uuid FROM owner_payout WHERE organization_id=NEW.organization_id AND (transaction_id=NEW.id OR reversal_transaction_id=NEW.id OR transaction_id=NEW.reverses_transaction_id);
 IF payout_uuid IS NOT NULL THEN PERFORM app_assert_owner_payout(payout_uuid,NEW.organization_id);
 ELSIF NEW.reference ~ '^PAYOUT:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(:VOID)?$'
 THEN RAISE EXCEPTION 'native owner payout journal requires its linked source'; END IF;
 RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER owner_payout_journal_integrity_guard AFTER INSERT ON financial_transaction
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app_owner_payout_journal_integrity_guard();

CREATE OR REPLACE FUNCTION app_financial_approval_stage_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'financial approval stages cannot be deleted'; END IF;
 IF TG_OP='INSERT' THEN
  IF NEW.state<>'PENDING' OR NEW.decided_by IS NOT NULL OR NEW.decided_at IS NOT NULL OR NEW.decision_reason IS NOT NULL THEN RAISE EXCEPTION 'approval stages start pending'; END IF;
  IF NOT EXISTS (SELECT 1 FROM approval_request a JOIN expense e ON e.organization_id=a.organization_id AND e.id=a.expense_id
    WHERE a.organization_id=NEW.organization_id AND a.id=NEW.approval_id AND e.state='PENDING_APPROVAL' AND e.currency=NEW.currency)
   AND NOT EXISTS(SELECT 1 FROM approval_request a JOIN owner_payout p ON p.organization_id=a.organization_id AND p.id=a.payout_id
    WHERE a.organization_id=NEW.organization_id AND a.id=NEW.approval_id AND p.state='PENDING_APPROVAL' AND p.currency=NEW.currency AND p.amount=NEW.amount AND p.owner_id=NEW.owner_id)
  THEN RAISE EXCEPTION 'financial approval stage requires its submitted financial source'; END IF;
 ELSE
  IF ROW(NEW.organization_id,NEW.id,NEW.approval_id,NEW.position,NEW.kind,NEW.owner_id,NEW.amount,NEW.currency,NEW.routing_snapshot)
   IS DISTINCT FROM ROW(OLD.organization_id,OLD.id,OLD.approval_id,OLD.position,OLD.kind,OLD.owner_id,OLD.amount,OLD.currency,OLD.routing_snapshot)
   OR OLD.state<>'PENDING' OR NEW.state NOT IN ('APPROVED','REJECTED','CANCELLED')
   OR NEW.decided_by IS NULL OR NEW.decided_at IS NULL OR NEW.decision_reason IS NULL OR length(trim(NEW.decision_reason))<6
  THEN RAISE EXCEPTION 'financial approval decisions are immutable and require attribution'; END IF;
 END IF;
 RETURN NEW;
END $$;

COMMIT;
