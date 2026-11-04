BEGIN;

-- Preserve the bank and original-cash guards; applications have a distinct,
-- complete native source and independently verified ownership vector.
DROP TRIGGER guest_deposit_source_guard ON posting;
CREATE CONSTRAINT TRIGGER guest_deposit_source_guard AFTER INSERT ON posting
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
 WHEN (coalesce(NEW.dimensions->>'deposit_operation','') NOT IN ('CASH_ADMISSION','APPLICATION'))
 EXECUTE FUNCTION app_guard_guest_deposit_posting();

CREATE FUNCTION app_guest_accommodation_owner_target(org uuid,booking_id uuid,gross numeric,
 owner_account uuid,company_account uuid)
 RETURNS TABLE(account_id uuid,bucket text,dimensions jsonb,debit numeric)
 LANGUAGE plpgsql STABLE SET search_path=public,pg_temp AS $$
DECLARE
 owners jsonb; original_confirmation jsonb; item jsonb; basis commission_snapshot%ROWTYPE;
 common jsonb; owner_dimensions jsonb; allocated numeric:=0; owner_gross numeric;
 fee numeric; fees numeric:=0; position integer:=0; roster_size integer;
BEGIN
 IF gross<0 OR gross<>round(gross,2) THEN RAISE EXCEPTION 'guest_application_exact_native_amount_required'; END IF;
 SELECT s.rules->'owners' INTO owners FROM reservation_financial_snapshot s
  WHERE s.organization_id=org AND s.reservation_id=booking_id AND jsonb_typeof(s.rules->'owners')='array'
  ORDER BY s.version ASC LIMIT 1;
 SELECT r.after INTO original_confirmation FROM reservation_revision r
  WHERE r.organization_id=org AND r.reservation_id=booking_id AND r.operation='CONFIRM'
  ORDER BY r.version ASC LIMIT 1;
 roster_size:=jsonb_array_length(owners);
 IF owners IS NULL OR roster_size=0 OR original_confirmation IS NULL
  OR (SELECT sum((x->>'shareBps')::integer) FROM jsonb_array_elements(owners) x)<>10000
  OR (SELECT count(DISTINCT x->>'ownerId') FROM jsonb_array_elements(owners) x)<>roster_size THEN
  RAISE EXCEPTION 'guest_application_original_native_owner_roster_required'; END IF;
 common:=jsonb_build_object('reservation_id',booking_id::text,'reservation_reference',original_confirmation->>'reference',
  'property_id',original_confirmation->>'propertyId','source',original_confirmation->>'source');
 FOR item IN SELECT x FROM jsonb_array_elements(owners) x LOOP
  position:=position+1;
  SELECT s.* INTO basis FROM commission_snapshot s WHERE s.organization_id=org
   AND s.reservation_id=booking_id AND s.owner_id=(item->>'ownerId')::uuid;
  IF NOT FOUND OR basis.property_id::text IS DISTINCT FROM original_confirmation->>'propertyId'
   OR basis.share_bps IS DISTINCT FROM (item->>'shareBps')::integer OR basis.share_bps NOT BETWEEN 0 AND 10000
   OR basis.commission_rate_bps NOT BETWEEN 0 AND 10000 OR basis.commission_basis<>'GROSS_ACCOMMODATION'
   OR basis.accrual_event<>'ON_CHECKOUT' THEN RAISE EXCEPTION 'guest_application_original_native_commission_required'; END IF;
  owner_gross:=CASE WHEN position=roster_size THEN gross-allocated ELSE least(round(gross*basis.share_bps/10000,2),gross-allocated) END;
  allocated:=allocated+owner_gross;fee:=round(owner_gross*basis.commission_rate_bps/10000,2);fees:=fees+fee;
  owner_dimensions:=common||jsonb_build_object('owner_id',basis.owner_id::text,'commission_snapshot_id',basis.id::text,
   'commission_rate_bps',basis.commission_rate_bps,'commission_basis',basis.commission_basis);
  IF owner_gross>0 THEN account_id:=owner_account;bucket:='OWNER_REVENUE';
   dimensions:=owner_dimensions||jsonb_build_object('posting_kind','owner_accommodation_revenue');debit:=-owner_gross;RETURN NEXT;END IF;
  IF fee>0 THEN account_id:=owner_account;bucket:='COMMISSION';
   dimensions:=owner_dimensions||jsonb_build_object('posting_kind','owner_commission');debit:=fee;RETURN NEXT;END IF;
 END LOOP;
 IF fees>0 THEN account_id:=company_account;bucket:='COMMISSION';
  dimensions:=common||jsonb_build_object('posting_kind','alvillas_commission_revenue');debit:=-fees;RETURN NEXT;END IF;
END;
$$;

CREATE FUNCTION app_guard_guest_funded_application() RETURNS trigger
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
 IF NOT FOUND OR NOT j.sealed OR j.reverses_transaction_id IS NOT NULL THEN
  RAISE EXCEPTION 'guest_application_original_sealed_journal_required'; END IF;
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

CREATE CONSTRAINT TRIGGER guest_funded_application_source_guard AFTER INSERT ON posting
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
 WHEN (NEW.dimensions->>'deposit_operation'='APPLICATION') EXECUTE FUNCTION app_guard_guest_funded_application();

COMMIT;
