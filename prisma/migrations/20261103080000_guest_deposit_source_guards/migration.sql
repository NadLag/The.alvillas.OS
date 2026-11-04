BEGIN;

CREATE INDEX guest_deposit_claim_history_idx ON posting
 (organization_id,(dimensions->>'deposit_id'),currency,ledger_account_id,id)
 WHERE dimensions->>'source'='GUEST_DEPOSIT';

CREATE FUNCTION app_guard_guest_deposit_posting() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE
 j record; evidence record; root financial_transaction%ROWTYPE;
 original financial_transaction%ROWTYPE; original_evidence jsonb;
 rule config_rule%ROWTYPE; claim posting%ROWTYPE; location posting%ROWTYPE;
 ds jsonb; saved jsonb; kind jsonb; deposit uuid; operation text; action_name text;
 claim_code text; location_code text; remaining numeric; r reservation%ROWTYPE;
BEGIN
 IF NOT coalesce((NEW.dimensions->>'source'='GUEST_DEPOSIT'
   OR NEW.dimensions ? 'deposit_id' OR NEW.dimensions ? 'deposit_operation'
   OR EXISTS(SELECT 1 FROM ledger_account a WHERE a.organization_id=NEW.organization_id
    AND a.id=NEW.ledger_account_id AND a.code ~ '^GUEST_(PREPAYMENT|DEPOSIT)(_[A-Z0-9_]+)?$')),false) THEN RETURN NEW; END IF;
 SELECT t.*,t.xmin::text AS row_xmin INTO j FROM financial_transaction t
  WHERE t.organization_id=NEW.organization_id AND t.id=NEW.transaction_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'guest_deposit_journal_required'; END IF;
 SELECT p.dimensions INTO ds FROM posting p WHERE p.organization_id=j.organization_id AND p.transaction_id=j.id ORDER BY p.id LIMIT 1;
 IF ds->>'source' IS DISTINCT FROM 'GUEST_DEPOSIT' OR NOT coalesce(ds->>'deposit_id','') ~* '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'
  OR ds->>'deposit_operation' NOT IN ('RECEIPT','REFUND') OR ds->>'deposit_operation' IS NULL
  OR (SELECT count(*) FROM posting p WHERE p.organization_id=j.organization_id AND p.transaction_id=j.id)<>2
  OR EXISTS(SELECT 1 FROM posting p WHERE p.organization_id=j.organization_id AND p.transaction_id=j.id
   AND (p.dimensions IS DISTINCT FROM ds OR p.xmin::text<>j.row_xmin)) THEN RAISE EXCEPTION 'guest_deposit_complete_source_required'; END IF;
 deposit:=(ds->>'deposit_id')::uuid;
 PERFORM pg_advisory_xact_lock(hashtextextended(j.organization_id::text||':financial-transfer:guest-deposit-source:'||deposit::text,0));
 operation:=CASE WHEN j.reverses_transaction_id IS NOT NULL THEN 'REVERSE' ELSE ds->>'deposit_operation' END;
 action_name:=CASE operation WHEN 'RECEIPT' THEN 'finance.guest_deposit.received' WHEN 'REFUND' THEN 'finance.guest_deposit.refunded' ELSE 'finance.guest_deposit.reversed' END;
 IF (SELECT count(*) FROM audit_log a WHERE a.organization_id=j.organization_id AND a.resource_type='financial_transaction' AND a.resource_id=j.id AND a.action=action_name)<>1 THEN
  RAISE EXCEPTION 'guest_deposit_atomic_audit_required'; END IF;
 SELECT a.*,a.xmin::text AS row_xmin INTO evidence FROM audit_log a WHERE a.organization_id=j.organization_id AND a.resource_type='financial_transaction' AND a.resource_id=j.id AND a.action=action_name;
 saved:=evidence.after;
 IF evidence.row_xmin<>j.row_xmin OR evidence.actor_id IS DISTINCT FROM j.created_by OR j.created_by IS NULL
  OR saved->>'schemaVersion' IS DISTINCT FROM '1' OR saved->>'operation' IS DISTINCT FROM operation
  OR saved->'source'->>'organizationId' IS DISTINCT FROM j.organization_id::text OR saved->'source'->>'depositId' IS DISTINCT FROM deposit::text
  OR saved->'source'->>'propertyId' IS DISTINCT FROM ds->>'property_id'
  OR saved->'source'->>'reservationId' IS DISTINCT FROM ds->>'reservation_id'
  OR saved->'source'->>'guestId' IS DISTINCT FROM ds->>'guest_id'
  OR saved->'source'->>'kind' IS DISTINCT FROM ds->>'deposit_kind'
  OR NOT coalesce(saved->>'commandHash','') ~ '^[a-f0-9]{64}$'
  OR NOT coalesce(saved->'input'->>'reviewFingerprint','') ~ '^[a-f0-9]{64}$'
  OR saved->'input'->>'reason' IS DISTINCT FROM evidence.reason OR length(coalesce(evidence.reason,''))<6
  OR j.idempotency_key IS DISTINCT FROM 'guest-deposit:'||(saved->'input'->>'idempotencyKey') THEN RAISE EXCEPTION 'guest_deposit_exact_native_receipt_required'; END IF;
 SELECT c.* INTO rule FROM config_rule c WHERE c.organization_id=j.organization_id AND c.id=(saved->'policy'->>'id')::uuid;
 IF NOT FOUND OR rule.key<>'finance.guest_deposits' OR rule.version::text IS DISTINCT FROM saved->'policy'->>'version'
  OR rule.value IS DISTINCT FROM saved->'policy'->'value' THEN RAISE EXCEPTION 'guest_deposit_original_policy_required'; END IF;
 SELECT p.* INTO claim FROM posting p WHERE p.organization_id=j.organization_id AND p.transaction_id=j.id AND p.ledger_account_id=(saved->>'liabilityAccountId')::uuid;
 IF NOT FOUND THEN RAISE EXCEPTION 'guest_deposit_original_claim_required'; END IF;
 SELECT a.code INTO claim_code FROM ledger_account a WHERE a.organization_id=j.organization_id AND a.id=claim.ledger_account_id AND a.account_type='CLAIM_OWNERSHIP' AND a.normal_side='CREDIT';
 IF claim_code IS NULL OR claim_code !~ '^GUEST_(PREPAYMENT|DEPOSIT)(_[A-Z0-9_]+)?$' OR claim.dimensions ? 'owner_id' OR claim.dimensions ? 'supplier_id' OR claim.dimensions ? 'person_id' THEN
  RAISE EXCEPTION 'guest_deposit_guest_liability_required'; END IF;
 SELECT p.* INTO location FROM posting p WHERE p.organization_id=j.organization_id AND p.transaction_id=j.id AND p.ledger_account_id<>claim.ledger_account_id;
 SELECT a.code INTO location_code FROM ledger_account a WHERE a.organization_id=j.organization_id AND a.id=location.ledger_account_id
  AND a.account_type IN ('ASSET','ASSET_LOCATION','STAFF_WALLET') AND a.normal_side='DEBIT' AND a.code NOT LIKE 'CASH_CUSTODY_%';
 IF location_code IS NULL OR location.currency<>claim.currency OR location.amount<>claim.amount OR location.side=claim.side THEN RAISE EXCEPTION 'guest_deposit_exact_location_required'; END IF;

 IF operation='RECEIPT' THEN
  IF j.reference IS DISTINCT FROM 'GUEST_DEPOSIT:'||deposit::text OR saved->'input'->>'idempotencyKey' IS DISTINCT FROM deposit::text
   OR claim.side<>'CREDIT' OR location.side<>'DEBIT' OR claim.currency IS DISTINCT FROM saved->'input'->>'currency'
   OR claim.amount<>(saved->'input'->>'amount')::numeric OR location.ledger_account_id::text IS DISTINCT FROM saved->'input'->>'accountId'
   OR j.occurred_at<>(saved->'input'->>'receivedAt')::timestamptz
   OR saved->'input'->>'reservationId' IS DISTINCT FROM ds->>'reservation_id' OR saved->'input'->>'kind' IS DISTINCT FROM ds->>'deposit_kind'
   OR j.description IS DISTINCT FROM saved->'input'->>'purpose'
   OR ds->>'payment_method' IS DISTINCT FROM saved->'input'->>'method' THEN RAISE EXCEPTION 'guest_deposit_original_receipt_mismatch'; END IF;
  SELECT x INTO kind FROM jsonb_array_elements(rule.value->'kinds') x WHERE x->>'key'=ds->>'deposit_kind';
  IF kind IS NULL OR kind->>'liability_account_code' IS DISTINCT FROM claim_code
   OR claim.bucket IS DISTINCT FROM rule.value->>'receipt_bucket'
   OR NOT rule.value->'receipt_account_codes' ? location_code THEN RAISE EXCEPTION 'guest_deposit_selected_receipt_treatment_required'; END IF;
  SELECT a.* INTO r FROM reservation a WHERE a.organization_id=j.organization_id AND a.id=(ds->>'reservation_id')::uuid;
  IF NOT FOUND OR r.property_id::text IS DISTINCT FROM ds->>'property_id' OR r.guest_id::text IS DISTINCT FROM ds->>'guest_id' OR r.archived_at IS NOT NULL THEN
   RAISE EXCEPTION 'guest_deposit_actual_reservation_required'; END IF;
 ELSE
  SELECT t.* INTO root FROM financial_transaction t WHERE t.organization_id=j.organization_id AND t.idempotency_key='guest-deposit:'||deposit::text
   AND t.reference='GUEST_DEPOSIT:'||deposit::text AND t.reverses_transaction_id IS NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'guest_deposit_original_receipt_required'; END IF;
  SELECT a.after INTO original_evidence FROM audit_log a WHERE a.organization_id=j.organization_id AND a.resource_type='financial_transaction' AND a.resource_id=root.id AND a.action='finance.guest_deposit.received';
  IF original_evidence IS NULL OR saved->'source' IS DISTINCT FROM original_evidence->'source'
   OR saved->>'liabilityAccountId' IS DISTINCT FROM original_evidence->>'liabilityAccountId'
   OR claim.currency IS DISTINCT FROM original_evidence->'input'->>'currency' THEN RAISE EXCEPTION 'guest_deposit_original_liability_mismatch'; END IF;
  IF operation='REFUND' THEN
   IF j.reference IS DISTINCT FROM 'GUEST_DEPOSIT_REFUND:'||(saved->'input'->>'idempotencyKey')
    OR claim.side<>'DEBIT' OR location.side<>'CREDIT' OR claim.amount<>(saved->'input'->>'amount')::numeric
    OR claim.currency IS DISTINCT FROM saved->'input'->>'currency' OR ds->>'deposit_refund_id' IS DISTINCT FROM saved->'input'->>'idempotencyKey'
    OR saved->'input'->>'depositId' IS DISTINCT FROM deposit::text OR saved->>'originalTransactionId' IS DISTINCT FROM root.id::text
    OR ds->>'original_transaction_id' IS DISTINCT FROM root.id::text OR location.ledger_account_id::text IS DISTINCT FROM saved->'input'->>'accountId'
    OR j.occurred_at<root.occurred_at OR j.description IS DISTINCT FROM saved->'input'->>'purpose'
    OR claim.bucket IS DISTINCT FROM rule.value->>'refund_bucket' OR NOT rule.value->'refund_account_codes' ? location_code
    OR ds->>'payment_method' IS DISTINCT FROM saved->'input'->>'method'
    OR EXISTS(SELECT 1 FROM financial_transaction v WHERE v.organization_id=j.organization_id AND v.reverses_transaction_id=root.id) THEN
     RAISE EXCEPTION 'guest_deposit_actual_refund_required'; END IF;
  ELSE
   SELECT t.* INTO original FROM financial_transaction t WHERE t.organization_id=j.organization_id AND t.id=j.reverses_transaction_id;
   IF NOT FOUND OR original.reverses_transaction_id IS NOT NULL OR j.reference IS DISTINCT FROM 'GUEST_DEPOSIT_VOID:'||(saved->'input'->>'idempotencyKey')
    OR saved->>'originalTransactionId' IS DISTINCT FROM original.id::text OR saved->'input'->>'transactionId' IS DISTINCT FROM original.id::text
    OR (SELECT count(*) FROM financial_transaction v WHERE v.organization_id=j.organization_id AND v.reverses_transaction_id=original.id)<>1
    OR EXISTS(SELECT 1 FROM posting p WHERE p.organization_id=j.organization_id AND p.transaction_id=j.id AND NOT EXISTS(
     SELECT 1 FROM posting o WHERE o.organization_id=p.organization_id AND o.transaction_id=original.id AND o.ledger_account_id=p.ledger_account_id
      AND o.currency=p.currency AND o.amount=p.amount AND o.bucket IS NOT DISTINCT FROM p.bucket AND o.dimensions IS NOT DISTINCT FROM p.dimensions AND o.side<>p.side)) THEN
     RAISE EXCEPTION 'guest_deposit_exact_opposite_required'; END IF;
  END IF;
 END IF;
 IF operation<>'REVERSE' AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(rule.value->'payment_methods') m WHERE m->>'key'=saved->'input'->>'method') THEN
  RAISE EXCEPTION 'guest_deposit_selected_payment_method_required'; END IF;
 SELECT coalesce(sum(CASE p.side WHEN 'CREDIT' THEN p.amount ELSE -p.amount END),0) INTO remaining FROM posting p
  WHERE p.organization_id=j.organization_id AND p.ledger_account_id=claim.ledger_account_id AND p.currency=claim.currency
  AND p.dimensions->>'source'='GUEST_DEPOSIT' AND p.dimensions->>'deposit_id'=deposit::text;
 IF remaining<0 THEN RAISE EXCEPTION 'guest_deposit_original_liability_exhausted'; END IF;
 RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER guest_deposit_source_guard AFTER INSERT ON posting
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app_guard_guest_deposit_posting();

COMMIT;
