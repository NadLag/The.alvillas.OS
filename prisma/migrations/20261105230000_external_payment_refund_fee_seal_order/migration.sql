BEGIN;

-- The existing deferred ledger sealer visits headers in insertion order. Other new headers can still
-- be unsealed during that visit, but must belong to this same transaction. The original mandatory
-- balance, immutable-header and final-seal constraints still execute for every header before commit.
CREATE OR REPLACE FUNCTION app_external_refund_fee_is_posted(refund_uuid uuid,organization_uuid uuid) RETURNS boolean LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE f external_payment_refund_fee%ROWTYPE; r external_payment_refund_intent%ROWTYPE; e expense%ROWTYPE; replacement expense%ROWTYPE;
  reversal financial_transaction%ROWTYPE; admitted financial_transaction%ROWTYPE; actual_at timestamptz; reversal_current boolean; admitted_current boolean;
BEGIN
  SELECT * INTO f FROM external_payment_refund_fee WHERE organization_id=organization_uuid AND refund_intent_id=refund_uuid;
  IF f.id IS NULL THEN RETURN false; END IF;
  PERFORM app_assert_external_refund_fee(f.id,organization_uuid);
  SELECT * INTO r FROM external_payment_refund_intent WHERE organization_id=organization_uuid AND id=refund_uuid;
  SELECT * INTO e FROM expense WHERE organization_id=organization_uuid AND id=f.original_expense_id;
  SELECT * INTO replacement FROM expense WHERE organization_id=organization_uuid AND id=f.correction_expense_id;
  SELECT t.* INTO reversal FROM financial_transaction t WHERE t.organization_id=organization_uuid AND t.reverses_transaction_id=e.transaction_id;
  SELECT xmin::text=pg_current_xact_id()::xid::text INTO reversal_current FROM financial_transaction WHERE organization_id=organization_uuid AND id=reversal.id;
  SELECT t.* INTO admitted FROM financial_transaction t WHERE t.organization_id=organization_uuid AND t.idempotency_key='guest-deposit:'||r.idempotency_key;
  SELECT xmin::text=pg_current_xact_id()::xid::text INTO admitted_current FROM financial_transaction WHERE organization_id=organization_uuid AND id=admitted.id;
  SELECT observation.refunded_at INTO actual_at FROM external_payment_refund_identity identity
    JOIN external_payment_refund_evidence observation ON observation.organization_id=identity.organization_id AND observation.identity_id=identity.id
    WHERE identity.organization_id=organization_uuid AND identity.intent_id=r.id AND observation.state='COMPLETED'
    ORDER BY observation.provider_updated_at,observation.id LIMIT 1;
  IF e.state IS DISTINCT FROM 'VOIDED' OR e.version IS DISTINCT FROM f.original_expense_version+1 OR reversal.id IS NULL OR (NOT reversal.sealed AND reversal_current IS DISTINCT FROM true)
    OR reversal.created_by IS DISTINCT FROM r.requested_by OR reversal.occurred_at IS DISTINCT FROM actual_at
    OR admitted.id IS NULL OR (NOT admitted.sealed AND admitted_current IS DISTINCT FROM true) OR admitted.created_by IS DISTINCT FROM r.requested_by OR admitted.occurred_at IS DISTINCT FROM actual_at
    OR (f.remaining_cost>0 AND (replacement.id IS NULL OR replacement.transaction_id IS NULL OR replacement.state NOT IN ('POSTED','VOIDED')
      OR NOT EXISTS(SELECT 1 FROM financial_transaction t WHERE t.organization_id=organization_uuid AND t.id=replacement.transaction_id
        AND (t.sealed OR t.xmin::text=pg_current_xact_id()::xid::text) AND t.created_by=r.requested_by AND t.occurred_at=actual_at)))
    THEN RETURN false; END IF;
  IF replacement.id IS NOT NULL THEN PERFORM app_assert_expense_posting(replacement.id,organization_uuid); END IF;
  RETURN true;
END $$;

COMMIT;
