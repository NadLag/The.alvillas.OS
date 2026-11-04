BEGIN;

-- The bank/refund guard retains its complete original implementation. Cash
-- ownership admissions and their opposites receive the independent guard below.
DROP TRIGGER guest_deposit_source_guard ON posting;
CREATE CONSTRAINT TRIGGER guest_deposit_source_guard AFTER INSERT ON posting
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
 WHEN (coalesce(NEW.dimensions->>'deposit_operation','')<>'CASH_ADMISSION')
 EXECUTE FUNCTION app_guard_guest_deposit_posting();

CREATE FUNCTION app_guard_guest_cash_admission() RETURNS trigger
 LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE
 j record; evidence record; saved jsonb; ds jsonb; action_name text; operation text;
 receipt cash_collection%ROWTYPE; original financial_transaction%ROWTYPE;
 rule config_rule%ROWTYPE; claim posting%ROWTYPE; unallocated posting%ROWTYPE;
 booking reservation%ROWTYPE; revision jsonb; kind jsonb; deposit uuid; remaining numeric;
BEGIN
 SELECT t.*,t.xmin::text AS row_xmin INTO j FROM financial_transaction t
  WHERE t.organization_id=NEW.organization_id AND t.id=NEW.transaction_id;
 IF NOT FOUND OR NOT j.sealed THEN RAISE EXCEPTION 'guest_cash_sealed_journal_required'; END IF;
 ds:=NEW.dimensions;
 IF ds->>'source' IS DISTINCT FROM 'GUEST_DEPOSIT'
  OR NOT coalesce(ds->>'deposit_id','') ~* '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'
  OR NOT coalesce(ds->>'cash_collection_id','') ~* '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'
  OR (SELECT count(*) FROM posting p WHERE p.organization_id=j.organization_id AND p.transaction_id=j.id)<>2
  OR EXISTS(SELECT 1 FROM posting p WHERE p.organization_id=j.organization_id AND p.transaction_id=j.id
   AND(p.dimensions IS DISTINCT FROM ds OR p.xmin::text<>j.row_xmin)) THEN
  RAISE EXCEPTION 'guest_cash_complete_original_source_required'; END IF;
 deposit:=(ds->>'deposit_id')::uuid;
 PERFORM pg_advisory_xact_lock(hashtextextended(j.organization_id::text||':financial-transfer:guest-deposit-source:'||deposit::text,0));
 operation:=CASE WHEN j.reverses_transaction_id IS NULL THEN 'ADMIT_CASH' ELSE 'REVERSE' END;
 action_name:=CASE operation WHEN 'ADMIT_CASH' THEN 'finance.guest_deposit.received' ELSE 'finance.guest_deposit.reversed' END;
 IF(SELECT count(*) FROM audit_log a WHERE a.organization_id=j.organization_id AND a.resource_type='financial_transaction' AND a.resource_id=j.id AND a.action=action_name)<>1 THEN RAISE EXCEPTION 'guest_cash_atomic_audit_required'; END IF;
 SELECT a.*,a.xmin::text AS row_xmin INTO evidence FROM audit_log a
  WHERE a.organization_id=j.organization_id AND a.resource_type='financial_transaction' AND a.resource_id=j.id AND a.action=action_name;
 saved:=evidence.after;
 IF evidence.row_xmin<>j.row_xmin OR evidence.actor_id IS DISTINCT FROM j.created_by OR j.created_by IS NULL
  OR saved->>'schemaVersion' IS DISTINCT FROM '1' OR saved->>'operation' IS DISTINCT FROM operation
  OR saved->'source'->>'organizationId' IS DISTINCT FROM j.organization_id::text
  OR saved->'source'->>'depositId' IS DISTINCT FROM deposit::text
  OR saved->'source'->>'propertyId' IS DISTINCT FROM ds->>'property_id'
  OR saved->'source'->>'reservationId' IS DISTINCT FROM ds->>'reservation_id'
  OR saved->'source'->>'guestId' IS DISTINCT FROM ds->>'guest_id'
  OR saved->'source'->>'kind' IS DISTINCT FROM ds->>'deposit_kind'
  OR NOT coalesce(saved->>'commandHash','') ~ '^[a-f0-9]{64}$'
  OR NOT coalesce(saved->'input'->>'reviewFingerprint','') ~ '^[a-f0-9]{64}$'
  OR saved->'input'->>'reason' IS DISTINCT FROM evidence.reason OR length(coalesce(evidence.reason,''))<6
  OR j.idempotency_key IS DISTINCT FROM 'guest-deposit:'||(saved->'input'->>'idempotencyKey') THEN
  RAISE EXCEPTION 'guest_cash_exact_native_acknowledgement_required'; END IF;
 SELECT c.* INTO receipt FROM cash_collection c WHERE c.organization_id=j.organization_id AND c.id=(ds->>'cash_collection_id')::uuid;
 IF NOT FOUND OR receipt.transaction_id::text IS DISTINCT FROM ds->>'original_collection_transaction_id'
  OR receipt.task_id::text IS DISTINCT FROM ds->>'task_id'
  OR receipt.property_id::text IS DISTINCT FROM ds->>'property_id'
  OR receipt.reservation_id::text IS DISTINCT FROM ds->>'reservation_id' THEN RAISE EXCEPTION 'guest_cash_actual_collection_required'; END IF;
 SELECT c.* INTO rule FROM config_rule c WHERE c.organization_id=j.organization_id AND c.id=(saved->'policy'->>'id')::uuid;
 IF NOT FOUND OR rule.key<>'finance.guest_deposits' OR rule.version::text IS DISTINCT FROM saved->'policy'->>'version'
  OR rule.value IS DISTINCT FROM saved->'policy'->'value' THEN RAISE EXCEPTION 'guest_cash_original_policy_required'; END IF;
 SELECT p.* INTO claim FROM posting p JOIN ledger_account a ON a.organization_id=p.organization_id AND a.id=p.ledger_account_id
  WHERE p.organization_id=j.organization_id AND p.transaction_id=j.id AND p.ledger_account_id=(saved->>'liabilityAccountId')::uuid
   AND a.account_type='CLAIM_OWNERSHIP' AND a.normal_side='CREDIT' AND a.code ~ '^GUEST_(PREPAYMENT|DEPOSIT)(_[A-Z0-9_]+)?$';
 IF NOT FOUND OR ds ? 'owner_id' OR ds ? 'person_id' OR ds ? 'supplier_id' THEN RAISE EXCEPTION 'guest_cash_original_guest_claim_required'; END IF;
 SELECT p.* INTO unallocated FROM posting p JOIN ledger_account a ON a.organization_id=p.organization_id AND a.id=p.ledger_account_id
  WHERE p.organization_id=j.organization_id AND p.transaction_id=j.id AND p.ledger_account_id<>claim.ledger_account_id
   AND a.code='UNALLOCATED_COLLECTIONS' AND a.account_type='CLAIM_OWNERSHIP' AND a.normal_side='CREDIT';
 IF NOT FOUND OR unallocated.currency<>claim.currency OR unallocated.amount<>claim.amount OR unallocated.side=claim.side
  OR claim.currency<>receipt.currency OR claim.bucket IS DISTINCT FROM rule.value->'cash_admission'->>'bucket'
  OR unallocated.bucket IS DISTINCT FROM claim.bucket THEN RAISE EXCEPTION 'guest_cash_ownership_only_required'; END IF;
 IF operation='ADMIT_CASH' THEN
  SELECT r.* INTO booking FROM reservation r WHERE r.organization_id=j.organization_id AND r.id=receipt.reservation_id;
  SELECT r.after INTO revision FROM reservation_revision r WHERE r.organization_id=j.organization_id AND r.reservation_id=receipt.reservation_id AND r.created_at<=receipt.recorded_at ORDER BY r.version DESC LIMIT 1;
  IF booking.id IS NULL OR revision IS NULL OR revision->>'guestId' IS DISTINCT FROM ds->>'guest_id' OR revision->>'propertyId' IS DISTINCT FROM receipt.property_id::text
   OR booking.archived_at IS NOT NULL OR booking.property_id<>receipt.property_id OR booking.guest_id::text IS DISTINCT FROM ds->>'guest_id'
   OR j.reference IS DISTINCT FROM 'GUEST_DEPOSIT:'||deposit::text
   OR saved->'input'->>'idempotencyKey' IS DISTINCT FROM deposit::text
   OR saved->'input'->>'reservationId' IS DISTINCT FROM receipt.reservation_id::text
   OR saved->'input'->>'collectionId' IS DISTINCT FROM receipt.id::text
   OR saved->'input'->>'kind' IS DISTINCT FROM ds->>'deposit_kind'
   OR saved->'input'->>'currency' IS DISTINCT FROM claim.currency
   OR claim.amount<>(saved->'input'->>'amount')::numeric OR claim.amount>receipt.amount
   OR j.description IS DISTINCT FROM saved->'input'->>'purpose'
   OR j.occurred_at<receipt.recorded_at OR claim.side<>'CREDIT' OR unallocated.side<>'DEBIT'
   OR saved->>'unallocatedAccountId' IS DISTINCT FROM unallocated.ledger_account_id::text
   OR saved->'cashSource'->>'id' IS DISTINCT FROM receipt.id::text
   OR saved->'cashSource'->>'transactionId' IS DISTINCT FROM receipt.transaction_id::text
   OR saved->'cashSource'->>'custodyAccountId' IS DISTINCT FROM receipt.custody_account_id::text
   OR saved->'cashSource'->>'taskId' IS DISTINCT FROM receipt.task_id::text
   OR saved->'cashSource'->>'taskType' IS DISTINCT FROM receipt.provenance->>'taskType'
   OR saved->'cashSource'->>'collectorUserAccountId' IS DISTINCT FROM receipt.collector_user_account_id::text
   OR saved->'cashSource'->>'collectorPersonId' IS DISTINCT FROM receipt.collector_person_id::text
   OR (saved->'cashSource'->>'recordedAt')::timestamptz IS DISTINCT FROM receipt.recorded_at
   OR (saved->'cashSource'->>'amount')::numeric IS DISTINCT FROM receipt.amount
   OR saved->'cashSource'->>'currency' IS DISTINCT FROM receipt.currency
   OR saved->'cashSource'->'provenance' IS DISTINCT FROM receipt.provenance
   OR rule.value->'cash_admission'->>'source' IS DISTINCT FROM 'ORIGINAL_FIELD_COLLECTION'
   OR rule.value->'cash_admission'->>'limit' IS DISTINCT FROM 'ORIGINAL_UNALLOCATED_CASH'
   OR NOT coalesce(rule.value->'cash_admission'->'task_types' ? (receipt.provenance->>'taskType'),false)
   OR EXISTS(SELECT 1 FROM financial_transaction v WHERE v.organization_id=j.organization_id AND v.reverses_transaction_id=receipt.transaction_id) THEN
   RAISE EXCEPTION 'guest_cash_exact_original_admission_required'; END IF;
  SELECT x INTO kind FROM jsonb_array_elements(rule.value->'kinds') x WHERE x->>'key'=ds->>'deposit_kind';
  IF kind IS NULL OR NOT EXISTS(SELECT 1 FROM ledger_account a WHERE a.organization_id=j.organization_id AND a.id=claim.ledger_account_id AND a.code=kind->>'liability_account_code') THEN RAISE EXCEPTION 'guest_cash_selected_guest_treatment_required'; END IF;
 ELSE
  SELECT t.* INTO original FROM financial_transaction t WHERE t.organization_id=j.organization_id AND t.id=j.reverses_transaction_id;
  IF NOT FOUND OR original.reverses_transaction_id IS NOT NULL OR original.reference IS DISTINCT FROM 'GUEST_DEPOSIT:'||deposit::text
   OR saved->>'originalTransactionId' IS DISTINCT FROM original.id::text
   OR saved->'input'->>'transactionId' IS DISTINCT FROM original.id::text
   OR j.reference IS DISTINCT FROM 'GUEST_DEPOSIT_VOID:'||(saved->'input'->>'idempotencyKey')
   OR (SELECT count(*) FROM financial_transaction v WHERE v.organization_id=j.organization_id AND v.reverses_transaction_id=original.id)<>1
   OR NOT EXISTS(SELECT 1 FROM audit_log a WHERE a.organization_id=j.organization_id AND a.resource_type='financial_transaction' AND a.resource_id=original.id AND a.action='finance.guest_deposit.received' AND a.after->>'operation'='ADMIT_CASH' AND a.after->'source'=saved->'source' AND a.after->>'liabilityAccountId'=saved->>'liabilityAccountId' AND a.after->'policy'=saved->'policy')
   OR EXISTS(SELECT 1 FROM posting p WHERE p.organization_id=j.organization_id AND p.transaction_id=j.id AND NOT EXISTS(
    SELECT 1 FROM posting o WHERE o.organization_id=p.organization_id AND o.transaction_id=original.id AND o.ledger_account_id=p.ledger_account_id AND o.currency=p.currency AND o.amount=p.amount AND o.bucket IS NOT DISTINCT FROM p.bucket AND o.dimensions IS NOT DISTINCT FROM p.dimensions AND o.side<>p.side)) THEN RAISE EXCEPTION 'guest_cash_exact_original_opposite_required'; END IF;
 END IF;
 SELECT coalesce(sum(CASE p.side WHEN 'CREDIT' THEN p.amount ELSE -p.amount END),0) INTO remaining FROM posting p
  WHERE p.organization_id=j.organization_id AND p.ledger_account_id=claim.ledger_account_id AND p.currency=claim.currency
   AND p.dimensions->>'source'='GUEST_DEPOSIT' AND p.dimensions->>'deposit_id'=deposit::text;
 IF remaining<0 THEN RAISE EXCEPTION 'guest_cash_original_liability_exhausted'; END IF;
 RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER guest_cash_admission_guard AFTER INSERT ON posting
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
 WHEN (NEW.dimensions->>'deposit_operation'='CASH_ADMISSION')
 EXECUTE FUNCTION app_guard_guest_cash_admission();

COMMIT;
