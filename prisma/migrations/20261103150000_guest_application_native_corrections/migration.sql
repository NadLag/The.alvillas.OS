BEGIN;

CREATE FUNCTION app_assert_guest_application_correction(org uuid,inverse_id uuid,adjustment_caller uuid DEFAULT NULL)
 RETURNS void LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE
 j record; original financial_transaction%ROWTYPE; evidence record; original_saved jsonb;
 saved jsonb; correction jsonb; root_saved jsonb; root financial_transaction%ROWTYPE;
 claim posting%ROWTYPE; rule config_rule%ROWTYPE; adjustment record; adjustment_evidence record;
 owner_account uuid; company_account uuid; adjustment_id uuid; booking_id uuid;
 amount numeric; total numeric; prior numeric; remaining numeric; mismatch boolean;
 expected jsonb; actual jsonb; field_name text; gross numeric;
 metadata_keys text[]:=ARRAY['deposit_id','deposit_kind','deposit_operation','deposit_application_id',
  'original_transaction_id','guest_id','application_source','booking_source','allocation_parent_transaction_id'];
BEGIN
 SELECT t.*,t.xmin::text AS row_xmin INTO j FROM financial_transaction t WHERE t.organization_id=org AND t.id=inverse_id;
 IF NOT FOUND OR NOT j.sealed OR j.reverses_transaction_id IS NULL THEN RAISE EXCEPTION 'guest_application_correction_sealed_opposite_required'; END IF;
 SELECT t.* INTO original FROM financial_transaction t WHERE t.organization_id=org AND t.id=j.reverses_transaction_id;
 SELECT a.after INTO original_saved FROM audit_log a WHERE a.organization_id=org AND a.resource_type='financial_transaction'
  AND a.resource_id=original.id AND a.action='finance.guest_deposit.applied';
 IF original.id IS NULL OR original.reverses_transaction_id IS NOT NULL OR original_saved IS NULL OR original_saved->>'operation' IS DISTINCT FROM 'APPLY'
  OR j.occurred_at<original.occurred_at OR NOT app_financial_period_is_open(org,j.occurred_at)
  OR (SELECT count(*) FROM financial_transaction v WHERE v.organization_id=org AND v.reverses_transaction_id=original.id)<>1 THEN
  RAISE EXCEPTION 'guest_application_correction_original_application_required'; END IF;
 booking_id:=(original_saved->'source'->>'reservationId')::uuid;
 PERFORM pg_advisory_xact_lock(hashtextextended(org::text||':reservation-financial-correction:'||booking_id::text,0));
 PERFORM pg_advisory_xact_lock(hashtextextended(org::text||':financial-transfer:guest-deposit-source:'||(original_saved->'source'->>'depositId'),0));
 IF(SELECT count(*) FROM audit_log a WHERE a.organization_id=org AND a.resource_type='financial_transaction' AND a.resource_id=j.id AND a.action='finance.guest_deposit.reversed')<>1 THEN RAISE EXCEPTION 'guest_application_correction_atomic_audit_required'; END IF;
 SELECT a.*,a.xmin::text AS row_xmin INTO evidence FROM audit_log a WHERE a.organization_id=org AND a.resource_type='financial_transaction'
  AND a.resource_id=j.id AND a.action='finance.guest_deposit.reversed';
 saved:=evidence.after;correction:=saved->'applicationCorrection';
 IF evidence.row_xmin<>j.row_xmin OR evidence.actor_id IS DISTINCT FROM j.created_by OR j.created_by IS NULL
  OR saved->>'schemaVersion' IS DISTINCT FROM '1' OR saved->>'operation' IS DISTINCT FROM 'REVERSE'
  OR saved->'source' IS DISTINCT FROM original_saved->'source' OR saved->>'liabilityAccountId' IS DISTINCT FROM original_saved->>'liabilityAccountId'
  OR saved->>'originalTransactionId' IS DISTINCT FROM original.id::text OR saved->'input'->>'transactionId' IS DISTINCT FROM original.id::text
  OR saved->'originalTransactionIds' IS DISTINCT FROM jsonb_build_array(original.id::text)
  OR saved->'reversalTransactionIds' IS DISTINCT FROM jsonb_build_array(j.id::text)
  OR correction->'originalSnapshot' IS DISTINCT FROM original_saved
  OR NOT coalesce(saved->>'commandHash','') ~ '^[a-f0-9]{64}$' OR NOT coalesce(saved->'input'->>'reviewFingerprint','') ~ '^[a-f0-9]{64}$'
  OR saved->'input'->>'reason' IS DISTINCT FROM evidence.reason OR length(coalesce(evidence.reason,''))<6 OR j.description IS DISTINCT FROM evidence.reason
  OR j.idempotency_key IS DISTINCT FROM 'guest-deposit:'||(saved->'input'->>'idempotencyKey')
  OR j.reference IS DISTINCT FROM 'GUEST_DEPOSIT_VOID:'||(saved->'input'->>'idempotencyKey') THEN
  RAISE EXCEPTION 'guest_application_correction_exact_native_receipt_required'; END IF;
 SELECT c.* INTO rule FROM config_rule c WHERE c.organization_id=org AND c.id=(saved->'policy'->>'id')::uuid;
 IF NOT FOUND OR rule.key<>'finance.guest_deposits' OR rule.version::text IS DISTINCT FROM saved->'policy'->>'version'
  OR rule.value IS DISTINCT FROM saved->'policy'->'value' OR rule.value->>'correction_date' IS DISTINCT FROM 'CURRENT_OPEN_PERIOD' THEN
  RAISE EXCEPTION 'guest_application_correction_current_open_treatment_required'; END IF;
 IF EXISTS(
  (SELECT p.ledger_account_id,CASE p.side WHEN 'DEBIT' THEN 'CREDIT' ELSE 'DEBIT' END AS side,p.amount,p.currency,p.bucket,p.dimensions FROM posting p WHERE p.organization_id=org AND p.transaction_id=original.id
   EXCEPT ALL SELECT p.ledger_account_id,p.side,p.amount,p.currency,p.bucket,p.dimensions FROM posting p WHERE p.organization_id=org AND p.transaction_id=j.id)
  UNION ALL
  (SELECT p.ledger_account_id,p.side,p.amount,p.currency,p.bucket,p.dimensions FROM posting p WHERE p.organization_id=org AND p.transaction_id=j.id
   EXCEPT ALL SELECT p.ledger_account_id,CASE p.side WHEN 'DEBIT' THEN 'CREDIT' ELSE 'DEBIT' END,p.amount,p.currency,p.bucket,p.dimensions FROM posting p WHERE p.organization_id=org AND p.transaction_id=original.id)
 ) OR EXISTS(SELECT 1 FROM posting p WHERE p.organization_id=org AND p.transaction_id=j.id AND p.xmin::text<>j.row_xmin) THEN
  RAISE EXCEPTION 'guest_application_correction_exact_original_opposite_required'; END IF;
 SELECT t.* INTO root FROM financial_transaction t WHERE t.organization_id=org AND t.id=(original_saved->>'originalTransactionId')::uuid
  AND t.idempotency_key='guest-deposit:'||(original_saved->'source'->>'depositId') AND t.reverses_transaction_id IS NULL;
 SELECT a.after INTO root_saved FROM audit_log a WHERE a.organization_id=org AND a.resource_type='financial_transaction' AND a.resource_id=root.id AND a.action='finance.guest_deposit.received';
 IF root.id IS NULL OR root_saved->'source' IS DISTINCT FROM original_saved->'source'
  OR EXISTS(SELECT 1 FROM financial_transaction v WHERE v.organization_id=org AND v.reverses_transaction_id=root.id) THEN
  RAISE EXCEPTION 'guest_application_correction_original_guest_root_required'; END IF;
 SELECT p.* INTO claim FROM posting p WHERE p.organization_id=org AND p.transaction_id=j.id AND p.ledger_account_id=(saved->>'liabilityAccountId')::uuid;
 amount:=(original_saved->'input'->>'amount')::numeric;owner_account:=(original_saved->>'ownerPayableAccountId')::uuid;company_account:=(original_saved->>'commissionRevenueAccountId')::uuid;
 IF claim.id IS NULL OR claim.side<>'CREDIT' OR claim.amount<>amount OR claim.currency IS DISTINCT FROM original_saved->'input'->>'currency' THEN
  RAISE EXCEPTION 'guest_application_correction_original_guest_funding_required'; END IF;
 SELECT coalesce(sum(CASE p.side WHEN 'DEBIT' THEN p.amount ELSE -p.amount END),0) INTO total FROM posting p JOIN ledger_account a ON a.organization_id=p.organization_id AND a.id=p.ledger_account_id
  WHERE p.organization_id=org AND p.currency=claim.currency AND p.dimensions->>'source'='GUEST_DEPOSIT'
   AND p.dimensions->>'reservation_id'=booking_id::text AND p.dimensions->>'application_source'='ORIGINAL_GUEST_PREPAYMENT'
   AND p.dimensions->>'deposit_operation'='APPLICATION' AND a.code ~ '^GUEST_(PREPAYMENT|DEPOSIT)(_[A-Z0-9_]+)?$';
 prior:=total+amount;
 SELECT coalesce(sum(CASE p.side WHEN 'CREDIT' THEN p.amount ELSE -p.amount END),0) INTO remaining FROM posting p
  WHERE p.organization_id=org AND p.ledger_account_id=claim.ledger_account_id AND p.currency=claim.currency
   AND p.dimensions->>'source'='GUEST_DEPOSIT' AND p.dimensions->>'deposit_id'=original_saved->'source'->>'depositId';
 IF total<0 OR remaining<0 OR remaining>(root_saved->'input'->>'amount')::numeric
  OR prior<>(correction->>'appliedBefore')::numeric OR total<>(correction->>'appliedAfter')::numeric THEN
  RAISE EXCEPTION 'guest_application_correction_exact_remaining_funds_required'; END IF;
 FOREACH field_name IN ARRAY ARRAY['nativeBefore','nativeAfter'] LOOP
  gross:=CASE field_name WHEN 'nativeBefore' THEN prior ELSE total END;
  expected:=app_guest_accommodation_native_target_snapshot(org,booking_id,gross,claim.currency,claim.ledger_account_id,owner_account,company_account);
  SELECT coalesce(jsonb_agg(x ORDER BY x::text),'[]'::jsonb) INTO actual FROM jsonb_array_elements(correction->field_name) x;
  IF correction->field_name IS NULL OR actual IS DISTINCT FROM expected THEN RAISE EXCEPTION 'guest_application_correction_retained_native_target_required'; END IF;
 END LOOP;
 adjustment_id:=(correction->>'adjustmentTransactionId')::uuid;
 IF adjustment_caller IS NOT NULL AND adjustment_caller IS DISTINCT FROM adjustment_id THEN RAISE EXCEPTION 'guest_application_correction_unacknowledged_adjustment'; END IF;

 IF adjustment_id IS NOT NULL THEN
  SELECT t.*,t.xmin::text AS row_xmin INTO adjustment FROM financial_transaction t WHERE t.organization_id=org AND t.id=adjustment_id;
  IF NOT FOUND OR NOT adjustment.sealed OR adjustment.reverses_transaction_id IS NOT NULL OR adjustment.row_xmin<>j.row_xmin
   OR adjustment.created_by IS DISTINCT FROM j.created_by OR adjustment.occurred_at<>j.occurred_at OR adjustment.description IS DISTINCT FROM evidence.reason
   OR adjustment.reference IS DISTINCT FROM 'GUEST_DEPOSIT_ALLOCATION:'||(saved->'input'->>'idempotencyKey')
   OR adjustment.idempotency_key IS DISTINCT FROM 'guest-deposit-allocation-adjustment:'||(saved->'input'->>'idempotencyKey') THEN
   RAISE EXCEPTION 'guest_application_correction_atomic_allocation_journal_required'; END IF;
  IF(SELECT count(*) FROM audit_log a WHERE a.organization_id=org AND a.resource_type='financial_transaction' AND a.resource_id=adjustment_id AND a.action='finance.guest_deposit.application_reallocated')<>1 THEN
   RAISE EXCEPTION 'guest_application_correction_atomic_allocation_audit_required'; END IF;
  SELECT a.*,a.xmin::text AS row_xmin INTO adjustment_evidence FROM audit_log a WHERE a.organization_id=org
   AND a.resource_type='financial_transaction' AND a.resource_id=adjustment_id AND a.action='finance.guest_deposit.application_reallocated';
  IF adjustment_evidence.row_xmin<>j.row_xmin OR adjustment_evidence.actor_id IS DISTINCT FROM j.created_by
   OR adjustment_evidence.reason IS DISTINCT FROM evidence.reason OR adjustment_evidence.after IS DISTINCT FROM saved
   OR EXISTS(SELECT 1 FROM posting p WHERE p.organization_id=org AND p.transaction_id=adjustment_id
    AND(p.xmin::text<>j.row_xmin OR p.currency<>claim.currency OR p.ledger_account_id NOT IN(owner_account,company_account)
     OR p.dimensions->>'source' IS DISTINCT FROM 'GUEST_DEPOSIT' OR p.dimensions->>'application_source' IS DISTINCT FROM 'ORIGINAL_GUEST_PREPAYMENT'
     OR p.dimensions->>'deposit_operation' IS DISTINCT FROM 'APPLICATION_ADJUSTMENT' OR p.dimensions->>'allocation_parent_transaction_id' IS DISTINCT FROM j.id::text
     OR p.dimensions->>'deposit_id' IS DISTINCT FROM original_saved->'source'->>'depositId'
     OR p.dimensions->>'deposit_kind' IS DISTINCT FROM original_saved->'source'->>'kind'
     OR p.dimensions->>'guest_id' IS DISTINCT FROM original_saved->'source'->>'guestId'
     OR p.dimensions->>'original_transaction_id' IS DISTINCT FROM root.id::text
     OR p.dimensions->>'deposit_application_id' IS DISTINCT FROM saved->'input'->>'idempotencyKey')) THEN
   RAISE EXCEPTION 'guest_application_correction_exact_allocation_receipt_required'; END IF;
 END IF;
 WITH expected_rows AS(
  SELECT x.account_id,x.bucket,x.dimensions,x.debit FROM app_guest_accommodation_owner_target(org,booking_id,total,owner_account,company_account) x
  UNION ALL SELECT x.account_id,x.bucket,x.dimensions,-x.debit FROM app_guest_accommodation_owner_target(org,booking_id,prior,owner_account,company_account) x
  UNION ALL SELECT p.ledger_account_id,p.bucket,(p.dimensions-metadata_keys)||jsonb_build_object('source',p.dimensions->>'booking_source'),CASE p.side WHEN 'DEBIT' THEN p.amount ELSE -p.amount END
   FROM posting p WHERE p.organization_id=org AND p.transaction_id=original.id AND p.ledger_account_id IN(owner_account,company_account)
 ), target AS(
  SELECT t.account_id,t.bucket,t.dimensions,sum(t.debit) AS debit FROM expected_rows t GROUP BY t.account_id,t.bucket,t.dimensions HAVING sum(t.debit)<>0
 ), actual_rows AS(
  SELECT p.ledger_account_id AS account_id,p.bucket,(p.dimensions-metadata_keys)||jsonb_build_object('source',p.dimensions->>'booking_source') AS dimensions,
   sum(CASE p.side WHEN 'DEBIT' THEN p.amount ELSE -p.amount END) AS debit FROM posting p WHERE p.organization_id=org AND p.transaction_id=adjustment_id
  GROUP BY p.ledger_account_id,p.bucket,(p.dimensions-metadata_keys)||jsonb_build_object('source',p.dimensions->>'booking_source')
 ) SELECT EXISTS(SELECT 1 FROM target t FULL JOIN actual_rows a ON a.account_id=t.account_id AND a.bucket IS NOT DISTINCT FROM t.bucket AND a.dimensions=t.dimensions
  WHERE a.debit IS DISTINCT FROM t.debit)
  OR (SELECT count(*) FROM posting p WHERE p.organization_id=org AND p.transaction_id=adjustment_id)<>(SELECT count(*) FROM target) INTO mismatch;
 IF mismatch THEN RAISE EXCEPTION 'guest_application_correction_exact_native_allocation_required'; END IF;
 WITH target AS(SELECT * FROM app_guest_accommodation_owner_target(org,booking_id,total,owner_account,company_account)),actual_rows AS(
  SELECT p.ledger_account_id AS account_id,p.bucket,(p.dimensions-metadata_keys)||jsonb_build_object('source',p.dimensions->>'booking_source') AS dimensions,
   sum(CASE p.side WHEN 'DEBIT' THEN p.amount ELSE -p.amount END) AS debit FROM posting p WHERE p.organization_id=org AND p.currency=claim.currency
   AND p.ledger_account_id IN(owner_account,company_account) AND p.dimensions->>'source'='GUEST_DEPOSIT'
   AND p.dimensions->>'application_source'='ORIGINAL_GUEST_PREPAYMENT' AND p.dimensions->>'reservation_id'=booking_id::text
   AND p.dimensions->>'deposit_operation' IN('APPLICATION','APPLICATION_ADJUSTMENT')
  GROUP BY p.ledger_account_id,p.bucket,(p.dimensions-metadata_keys)||jsonb_build_object('source',p.dimensions->>'booking_source') HAVING sum(CASE p.side WHEN 'DEBIT' THEN p.amount ELSE -p.amount END)<>0
 ) SELECT EXISTS(SELECT 1 FROM target t FULL JOIN actual_rows a ON a.account_id=t.account_id AND a.bucket IS NOT DISTINCT FROM t.bucket AND a.dimensions=t.dimensions
  WHERE a.debit IS DISTINCT FROM t.debit) INTO mismatch;
 IF mismatch THEN RAISE EXCEPTION 'guest_application_correction_complete_native_target_required'; END IF;
END;
$$;

CREATE OR REPLACE FUNCTION app_guard_guest_funded_application() RETURNS trigger
 LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE
 j record; evidence record; saved jsonb; root financial_transaction%ROWTYPE; original jsonb;
 claim posting%ROWTYPE; rule config_rule%ROWTYPE; checkout reservation_revision%ROWTYPE;
 confirmation reservation_revision%ROWTYPE; quote reservation_financial_snapshot%ROWTYPE;
 booking reservation%ROWTYPE; amount numeric; total numeric; prior numeric; remaining numeric;
 deposit uuid; owner_account uuid; company_account uuid; kind jsonb; mismatch boolean;
 metadata_keys text[]:=ARRAY['deposit_id','deposit_kind','deposit_operation','deposit_application_id',
  'original_transaction_id','guest_id','application_source','booking_source','allocation_parent_transaction_id'];
BEGIN
 SELECT t.*,t.xmin::text AS row_xmin INTO j FROM financial_transaction t
  WHERE t.organization_id=NEW.organization_id AND t.id=NEW.transaction_id;
 IF NOT FOUND OR NOT j.sealed THEN
  RAISE EXCEPTION 'guest_application_original_sealed_journal_required'; END IF;
 IF j.reverses_transaction_id IS NOT NULL THEN
  PERFORM app_assert_guest_application_correction(NEW.organization_id,j.id);RETURN NEW;END IF;
 IF NEW.dimensions->>'source' IS DISTINCT FROM 'GUEST_DEPOSIT'
  OR NEW.dimensions->>'application_source' IS DISTINCT FROM 'ORIGINAL_GUEST_PREPAYMENT'
  OR NOT coalesce(NEW.dimensions->>'deposit_id','') ~* '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$' THEN
  RAISE EXCEPTION 'guest_application_original_guest_source_required'; END IF;
 deposit:=(NEW.dimensions->>'deposit_id')::uuid;
 PERFORM pg_advisory_xact_lock(hashtextextended(j.organization_id::text||':reservation-financial-correction:'||(NEW.dimensions->>'reservation_id'),0));
 PERFORM pg_advisory_xact_lock(hashtextextended(j.organization_id::text||':financial-transfer:guest-deposit-source:'||deposit::text,0));
 IF (SELECT count(*) FROM audit_log a WHERE a.organization_id=j.organization_id AND a.resource_type='financial_transaction'
  AND a.resource_id=j.id AND a.action='finance.guest_deposit.applied')<>1 THEN RAISE EXCEPTION 'guest_application_atomic_audit_required'; END IF;
 SELECT a.*,a.xmin::text AS row_xmin INTO evidence FROM audit_log a WHERE a.organization_id=j.organization_id
  AND a.resource_type='financial_transaction' AND a.resource_id=j.id AND a.action='finance.guest_deposit.applied';
 saved:=evidence.after;
 IF evidence.row_xmin<>j.row_xmin OR evidence.actor_id IS DISTINCT FROM j.created_by OR j.created_by IS NULL
  OR saved->>'schemaVersion' IS DISTINCT FROM '1' OR saved->>'operation' IS DISTINCT FROM 'APPLY'
  OR NOT coalesce(saved->>'commandHash','') ~ '^[a-f0-9]{64}$'
  OR NOT coalesce(saved->'input'->>'reviewFingerprint','') ~ '^[a-f0-9]{64}$'
  OR saved->'input'->>'depositId' IS DISTINCT FROM deposit::text
  OR saved->'input'->>'reason' IS DISTINCT FROM evidence.reason OR length(coalesce(evidence.reason,''))<6
  OR j.description IS DISTINCT FROM evidence.reason
  OR j.idempotency_key IS DISTINCT FROM 'guest-deposit:'||(saved->'input'->>'idempotencyKey')
  OR j.reference IS DISTINCT FROM 'GUEST_DEPOSIT_APPLICATION:'||(saved->'input'->>'idempotencyKey') THEN
  RAISE EXCEPTION 'guest_application_exact_native_command_required'; END IF;
 SELECT t.* INTO root FROM financial_transaction t WHERE t.organization_id=j.organization_id
  AND t.idempotency_key='guest-deposit:'||deposit::text AND t.reference='GUEST_DEPOSIT:'||deposit::text AND t.reverses_transaction_id IS NULL;
 IF NOT FOUND OR root.id::text IS DISTINCT FROM saved->>'originalTransactionId' OR root.occurred_at>j.occurred_at
  OR EXISTS(SELECT 1 FROM financial_transaction v WHERE v.organization_id=j.organization_id AND v.reverses_transaction_id=root.id) THEN
  RAISE EXCEPTION 'guest_application_original_unopposed_deposit_required'; END IF;
 SELECT a.after INTO original FROM audit_log a WHERE a.organization_id=j.organization_id AND a.resource_type='financial_transaction'
  AND a.resource_id=root.id AND a.action='finance.guest_deposit.received';
 IF original IS NULL OR original->'source' IS DISTINCT FROM saved->'source'
  OR original->>'liabilityAccountId' IS DISTINCT FROM saved->>'liabilityAccountId'
  OR original->'source'->>'organizationId' IS DISTINCT FROM j.organization_id::text
  OR original->'source'->>'depositId' IS DISTINCT FROM deposit::text THEN RAISE EXCEPTION 'guest_application_original_deposit_evidence_required'; END IF;
 SELECT x INTO kind FROM jsonb_array_elements(original->'policy'->'value'->'kinds') x WHERE x->>'key'=original->'source'->>'kind';
 IF kind IS NULL OR kind->>'application' IS DISTINCT FROM 'ACCOMMODATION_PREPAYMENT' THEN RAISE EXCEPTION 'guest_application_security_deposit_protected'; END IF;
 SELECT c.* INTO rule FROM config_rule c WHERE c.organization_id=j.organization_id AND c.id=(saved->'policy'->>'id')::uuid;
 IF NOT FOUND OR rule.key<>'finance.guest_deposits' OR rule.version::text IS DISTINCT FROM saved->'policy'->>'version'
  OR rule.value IS DISTINCT FROM saved->'policy'->'value'
  OR rule.value->'application' IS DISTINCT FROM '{"source":"ORIGINAL_GUEST_PREPAYMENT","recognition":"ORIGINAL_BOOKING_ACCRUAL_EVENT","application_event":"ACTUAL_CHECKOUT","application_date":"CURRENT_OPEN_PERIOD","allocation":"CUMULATIVE_ORIGINAL_NATIVE_TARGET"}'::jsonb THEN
  RAISE EXCEPTION 'guest_application_explicit_selected_treatment_required'; END IF;
 SELECT r.* INTO booking FROM reservation r WHERE r.organization_id=j.organization_id AND r.id=(saved->'source'->>'reservationId')::uuid;
 IF NOT FOUND OR booking.archived_at IS NOT NULL OR booking.property_id::text IS DISTINCT FROM saved->'source'->>'propertyId'
  OR booking.guest_id::text IS DISTINCT FROM saved->'source'->>'guestId'
  OR booking.status NOT IN ('CHECKED_OUT','FINANCIAL_RECONCILIATION','CLOSED') THEN RAISE EXCEPTION 'guest_application_actual_native_checkout_required'; END IF;
 SELECT r.* INTO checkout FROM reservation_revision r WHERE r.organization_id=j.organization_id AND r.reservation_id=booking.id
  AND r.operation IN('TRANSITION','EARLY_CHECKOUT') AND r.after->>'status'='CHECKED_OUT' ORDER BY r.version DESC LIMIT 1;
 SELECT r.* INTO confirmation FROM reservation_revision r WHERE r.organization_id=j.organization_id AND r.reservation_id=booking.id
  AND r.operation='CONFIRM' ORDER BY r.version ASC LIMIT 1;
 SELECT s.* INTO quote FROM reservation_financial_snapshot s WHERE s.organization_id=j.organization_id AND s.reservation_id=booking.id ORDER BY s.version DESC LIMIT 1;
 IF checkout.id IS NULL OR confirmation.id IS NULL OR quote.id IS NULL
  OR checkout.id::text IS DISTINCT FROM saved->>'checkoutRevisionId' OR confirmation.id::text IS DISTINCT FROM saved->>'confirmationRevisionId'
  OR quote.id::text IS DISTINCT FROM saved->>'financialSnapshotId' OR checkout.created_at>j.occurred_at OR confirmation.created_at>checkout.created_at
  OR checkout.version>booking.version OR quote.version>booking.version OR confirmation.version>checkout.version
  OR quote.amount IS NULL OR quote.amount<=0 OR quote.currency IS DISTINCT FROM saved->'input'->>'currency'
  OR quote.currency IS DISTINCT FROM (SELECT o.base_currency FROM organization o WHERE o.id=j.organization_id)
  OR NOT app_financial_period_is_open(j.organization_id,checkout.created_at)
  OR NOT app_financial_period_is_open(j.organization_id,j.occurred_at) THEN RAISE EXCEPTION 'guest_application_original_open_economic_source_required'; END IF;
 owner_account:=(saved->>'ownerPayableAccountId')::uuid;company_account:=(saved->>'commissionRevenueAccountId')::uuid;
 IF NOT EXISTS(SELECT 1 FROM ledger_account a WHERE a.organization_id=j.organization_id AND a.id=owner_account AND a.code='OWNER_PAYABLE' AND a.account_type='CLAIM_OWNERSHIP' AND a.normal_side='CREDIT' AND a.archived_at IS NULL)
  OR NOT EXISTS(SELECT 1 FROM ledger_account a WHERE a.organization_id=j.organization_id AND a.id=company_account AND a.code='ALVILLAS_COMMISSION_REVENUE' AND a.account_type='ALVILLAS_OWN' AND a.normal_side='CREDIT' AND a.archived_at IS NULL) THEN
  RAISE EXCEPTION 'guest_application_native_ownership_accounts_required'; END IF;
 SELECT p.* INTO claim FROM posting p WHERE p.organization_id=j.organization_id AND p.transaction_id=j.id AND p.ledger_account_id=(saved->>'liabilityAccountId')::uuid;
 IF NOT FOUND OR claim.side<>'DEBIT' OR claim.currency<>quote.currency OR claim.amount<>(saved->'input'->>'amount')::numeric
  OR claim.amount<=0 OR claim.bucket<>'OWNER_REVENUE' OR claim.dimensions ? 'owner_id'
  OR (claim.dimensions-metadata_keys)||jsonb_build_object('source',claim.dimensions->>'booking_source') IS DISTINCT FROM
   jsonb_build_object('source',confirmation.after->>'source','reservation_id',booking.id::text,'reservation_reference',confirmation.after->>'reference',
    'property_id',booking.property_id::text,'posting_kind','accommodation_revenue_received')
  OR (SELECT count(*) FROM posting p WHERE p.organization_id=j.organization_id AND p.transaction_id=j.id AND p.ledger_account_id=claim.ledger_account_id)<>1
  OR NOT EXISTS(SELECT 1 FROM posting p WHERE p.organization_id=root.organization_id AND p.transaction_id=root.id AND p.ledger_account_id=claim.ledger_account_id AND p.side='CREDIT' AND p.currency=claim.currency)
  OR EXISTS(SELECT 1 FROM posting p WHERE p.organization_id=j.organization_id AND p.transaction_id=j.id
   AND(p.ledger_account_id NOT IN(claim.ledger_account_id,owner_account,company_account) OR p.currency<>claim.currency OR p.xmin::text<>j.row_xmin
    OR p.dimensions->>'source' IS DISTINCT FROM 'GUEST_DEPOSIT' OR p.dimensions->>'deposit_operation' IS DISTINCT FROM 'APPLICATION'
    OR p.dimensions->>'application_source' IS DISTINCT FROM 'ORIGINAL_GUEST_PREPAYMENT' OR p.dimensions->>'deposit_id' IS DISTINCT FROM deposit::text
    OR p.dimensions->>'reservation_id' IS DISTINCT FROM booking.id::text OR p.dimensions->>'property_id' IS DISTINCT FROM booking.property_id::text
    OR p.dimensions->>'guest_id' IS DISTINCT FROM booking.guest_id::text OR p.dimensions->>'deposit_kind' IS DISTINCT FROM original->'source'->>'kind'
    OR p.dimensions->>'original_transaction_id' IS DISTINCT FROM root.id::text OR p.dimensions->>'deposit_application_id' IS DISTINCT FROM saved->'input'->>'idempotencyKey'
    OR p.dimensions->>'booking_source' IS DISTINCT FROM confirmation.after->>'source')) THEN RAISE EXCEPTION 'guest_application_complete_exact_funding_vector_required'; END IF;
 IF EXISTS(SELECT 1 FROM financial_transaction t JOIN posting p ON p.organization_id=t.organization_id AND p.transaction_id=t.id
  WHERE t.organization_id=j.organization_id AND t.reverses_transaction_id IS NULL AND p.bucket IN('OWNER_REVENUE','COMMISSION')
   AND p.dimensions->>'reservation_id'=booking.id::text
   AND (p.dimensions->>'source' IS DISTINCT FROM 'GUEST_DEPOSIT' OR p.dimensions->>'application_source' IS DISTINCT FROM 'ORIGINAL_GUEST_PREPAYMENT')
   AND NOT EXISTS(SELECT 1 FROM financial_transaction v WHERE v.organization_id=t.organization_id AND v.reverses_transaction_id=t.id)) THEN
  RAISE EXCEPTION 'guest_application_existing_native_recognition_protected'; END IF;
 amount:=claim.amount;
 SELECT coalesce(sum(CASE p.side WHEN 'DEBIT' THEN p.amount ELSE -p.amount END),0) INTO total FROM posting p JOIN ledger_account a ON a.organization_id=p.organization_id AND a.id=p.ledger_account_id
  WHERE p.organization_id=j.organization_id AND p.currency=claim.currency AND p.dimensions->>'source'='GUEST_DEPOSIT'
  AND p.dimensions->>'reservation_id'=booking.id::text AND p.dimensions->>'application_source'='ORIGINAL_GUEST_PREPAYMENT'
  AND p.dimensions->>'deposit_operation'='APPLICATION' AND a.code ~ '^GUEST_(PREPAYMENT|DEPOSIT)(_[A-Z0-9_]+)?$';
 prior:=total-amount;
 SELECT coalesce(sum(CASE p.side WHEN 'CREDIT' THEN p.amount ELSE -p.amount END),0) INTO remaining FROM posting p
  WHERE p.organization_id=j.organization_id AND p.ledger_account_id=claim.ledger_account_id AND p.currency=claim.currency
  AND p.dimensions->>'source'='GUEST_DEPOSIT' AND p.dimensions->>'deposit_id'=deposit::text;
 IF remaining<0 OR prior<0 OR total>quote.amount OR prior<>(saved->>'appliedBefore')::numeric OR total<>(saved->>'appliedAfter')::numeric THEN
  RAISE EXCEPTION 'guest_application_original_funds_and_quote_cap_required'; END IF;
 -- The per-command difference and the complete retained native target must both
 -- match. Financial rates and rounding come from immutable native snapshots.
 WITH target AS(
  SELECT t.account_id,t.bucket,t.dimensions,sum(t.debit) AS debit FROM(
   SELECT * FROM app_guest_accommodation_owner_target(j.organization_id,booking.id,total,owner_account,company_account)
   UNION ALL SELECT x.account_id,x.bucket,x.dimensions,-x.debit FROM app_guest_accommodation_owner_target(j.organization_id,booking.id,prior,owner_account,company_account) x
  )t GROUP BY t.account_id,t.bucket,t.dimensions HAVING sum(t.debit)<>0
 ), actual AS(
  SELECT p.ledger_account_id AS account_id,p.bucket,(p.dimensions-metadata_keys)||jsonb_build_object('source',p.dimensions->>'booking_source') AS dimensions,
   sum(CASE p.side WHEN 'DEBIT' THEN p.amount ELSE -p.amount END) AS debit
  FROM posting p WHERE p.organization_id=j.organization_id AND p.transaction_id=j.id AND p.ledger_account_id<>claim.ledger_account_id
  GROUP BY p.ledger_account_id,p.bucket,(p.dimensions-metadata_keys)||jsonb_build_object('source',p.dimensions->>'booking_source')
 ) SELECT EXISTS(SELECT 1 FROM target t FULL JOIN actual a ON a.account_id=t.account_id AND a.bucket IS NOT DISTINCT FROM t.bucket AND a.dimensions=t.dimensions
  WHERE a.debit IS DISTINCT FROM t.debit) OR (SELECT count(*) FROM posting p WHERE p.organization_id=j.organization_id AND p.transaction_id=j.id)<>(SELECT count(*)+1 FROM target) INTO mismatch;
 IF mismatch THEN RAISE EXCEPTION 'guest_application_exact_native_target_delta_required'; END IF;
 WITH target AS(SELECT * FROM app_guest_accommodation_owner_target(j.organization_id,booking.id,total,owner_account,company_account)),actual AS(
  SELECT p.ledger_account_id AS account_id,p.bucket,(p.dimensions-metadata_keys)||jsonb_build_object('source',p.dimensions->>'booking_source') AS dimensions,
   sum(CASE p.side WHEN 'DEBIT' THEN p.amount ELSE -p.amount END) AS debit
  FROM posting p WHERE p.organization_id=j.organization_id AND p.currency=claim.currency AND p.ledger_account_id IN(owner_account,company_account)
   AND p.dimensions->>'source'='GUEST_DEPOSIT' AND p.dimensions->>'application_source'='ORIGINAL_GUEST_PREPAYMENT'
   AND p.dimensions->>'reservation_id'=booking.id::text AND p.dimensions->>'deposit_operation' IN('APPLICATION','APPLICATION_ADJUSTMENT')
  GROUP BY p.ledger_account_id,p.bucket,(p.dimensions-metadata_keys)||jsonb_build_object('source',p.dimensions->>'booking_source') HAVING sum(CASE p.side WHEN 'DEBIT' THEN p.amount ELSE -p.amount END)<>0
 ) SELECT EXISTS(SELECT 1 FROM target t FULL JOIN actual a ON a.account_id=t.account_id AND a.bucket IS NOT DISTINCT FROM t.bucket AND a.dimensions=t.dimensions
  WHERE a.debit IS DISTINCT FROM t.debit) INTO mismatch;
 IF mismatch THEN RAISE EXCEPTION 'guest_application_complete_retained_native_target_required'; END IF;
 RETURN NEW;
END;
$$;


DROP TRIGGER guest_deposit_source_guard ON posting;
CREATE CONSTRAINT TRIGGER guest_deposit_source_guard AFTER INSERT ON posting
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
 WHEN (coalesce(NEW.dimensions->>'deposit_operation','') NOT IN ('CASH_ADMISSION','APPLICATION','APPLICATION_ADJUSTMENT'))
 EXECUTE FUNCTION app_guard_guest_deposit_posting();

CREATE FUNCTION app_guard_guest_application_adjustment() RETURNS trigger
 LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
 IF NEW.dimensions->>'source' IS DISTINCT FROM 'GUEST_DEPOSIT'
  OR NEW.dimensions->>'application_source' IS DISTINCT FROM 'ORIGINAL_GUEST_PREPAYMENT'
  OR NOT coalesce(NEW.dimensions->>'allocation_parent_transaction_id','') ~* '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$' THEN
  RAISE EXCEPTION 'guest_application_correction_actual_parent_required';END IF;
 PERFORM app_assert_guest_application_correction(NEW.organization_id,(NEW.dimensions->>'allocation_parent_transaction_id')::uuid,NEW.transaction_id);
 RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER guest_application_adjustment_source_guard AFTER INSERT ON posting
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
 WHEN (NEW.dimensions->>'deposit_operation'='APPLICATION_ADJUSTMENT') EXECUTE FUNCTION app_guard_guest_application_adjustment();

COMMIT;
