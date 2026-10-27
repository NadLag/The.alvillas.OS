BEGIN;

-- A cancelled approved source retains its completed reviewer decisions.
-- Pending cancellations still require a cancelled/rejected header and no pending stages.
-- Only the integrity function changes; no business rows or applied SQL are rewritten.
CREATE OR REPLACE FUNCTION app_assert_owner_payout(payout_uuid uuid,organization_uuid uuid) RETURNS void LANGUAGE plpgsql AS $$
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
  IF p.state IN('APPROVED','SCHEDULED','PAID','RECONCILED','FAILED') OR p.transaction_id IS NOT NULL OR p.approved_at IS NOT NULL THEN
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

COMMIT;
