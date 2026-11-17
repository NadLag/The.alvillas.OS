-- Extend the canonical physical transfer journal. Keep every original transfer
-- and reversal guard intact, and never rewrite financial history.
ALTER FUNCTION app_assert_native_financial_transfer(uuid,uuid) RENAME TO app_assert_native_financial_transfer_before_custody;
CREATE FUNCTION app_assert_native_financial_transfer(journal_uuid uuid,organization_uuid uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE journal financial_transaction%ROWTYPE; proof audit_log%ROWTYPE; receipt cash_collection%ROWTYPE;
 source_account ledger_account%ROWTYPE; destination_account ledger_account%ROWTYPE;
 original financial_transaction%ROWTYPE; request_uuid uuid; remaining numeric; amount numeric; expected_dimensions jsonb;
BEGIN
 SELECT * INTO journal FROM financial_transaction WHERE organization_id=organization_uuid AND id=journal_uuid;
 IF journal.id IS NULL THEN RETURN;END IF;
 IF journal.reverses_transaction_id IS NOT NULL THEN
  SELECT * INTO receipt FROM cash_collection WHERE organization_id=organization_uuid AND transaction_id=journal.reverses_transaction_id;
  IF receipt.id IS NOT NULL AND EXISTS(SELECT 1 FROM posting p JOIN financial_transaction j ON j.organization_id=p.organization_id AND j.id=p.transaction_id WHERE p.organization_id=organization_uuid AND p.ledger_account_id=receipt.custody_account_id AND p.currency=receipt.currency AND j.sealed AND p.dimensions->>'custody_collection_id'=receipt.id::text GROUP BY p.currency HAVING sum(CASE WHEN p.side='CREDIT' THEN p.amount ELSE -p.amount END)>0)
  THEN RAISE EXCEPTION 'reverse_actual_cash_handovers_before_original_collection';END IF;
 END IF;
 SELECT * INTO proof FROM audit_log WHERE organization_id=organization_uuid AND resource_type='financial_transaction' AND resource_id=journal.id AND action='finance.transfer.posted' ORDER BY created_at LIMIT 1;
 IF journal.reference NOT LIKE 'TRANSFER:%' OR proof.after->>'kind' IS DISTINCT FROM 'CUSTODY_HANDOVER' THEN
  PERFORM app_assert_native_financial_transfer_before_custody(journal_uuid,organization_uuid);RETURN;
 END IF;
 IF journal.reference !~ '^TRANSFER:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' OR journal.reverses_transaction_id IS NOT NULL
  OR journal.created_by IS NULL OR proof.actor_id IS DISTINCT FROM journal.created_by OR proof.xmin::text<>journal.xmin::text OR journal.xmin::text<>pg_current_xact_id()::xid::text
  OR journal.occurred_at<date_trunc('milliseconds',transaction_timestamp()) OR journal.occurred_at>clock_timestamp()
  OR proof.after->>'reason' IS DISTINCT FROM proof.reason OR length(btrim(proof.reason)) NOT BETWEEN 6 AND 500
  OR proof.after->>'purpose' IS DISTINCT FROM journal.description
  OR COALESCE(proof.after->>'cashCollectionId','') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  OR COALESCE(proof.after->>'fromAccountId','') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  OR COALESCE(proof.after->>'toAccountId','') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  OR COALESCE(proof.after->>'amount','') !~ '^(0|[1-9][0-9]{0,15})(\.[0-9]{1,2})?$'
 THEN RAISE EXCEPTION 'cash_handover_original_attributed_source_required';END IF;
 request_uuid:=substring(journal.reference FROM 10)::uuid;amount:=(proof.after->>'amount')::numeric;
 IF proof.after->>'idempotencyKey' IS DISTINCT FROM request_uuid::text OR journal.idempotency_key IS DISTINCT FROM 'transfer:'||request_uuid::text THEN RAISE EXCEPTION 'cash_handover_original_command_required';END IF;
 SELECT * INTO receipt FROM cash_collection WHERE organization_id=organization_uuid AND id=(proof.after->>'cashCollectionId')::uuid;
 SELECT * INTO source_account FROM ledger_account WHERE organization_id=organization_uuid AND id=(proof.after->>'fromAccountId')::uuid;
 SELECT * INTO destination_account FROM ledger_account WHERE organization_id=organization_uuid AND id=(proof.after->>'toAccountId')::uuid;
 SELECT * INTO original FROM financial_transaction WHERE organization_id=organization_uuid AND id=receipt.transaction_id;
 IF receipt.id IS NULL OR source_account.id IS NULL OR destination_account.id IS NULL OR source_account.id=destination_account.id
  OR receipt.custody_account_id<>source_account.id OR source_account.code<>'CASH_CUSTODY_'||upper(replace(receipt.collector_person_id::text,'-',''))
  OR source_account.account_type<>'ASSET_LOCATION' OR source_account.normal_side<>'DEBIT' OR source_account.archived_at IS NOT NULL
  OR destination_account.account_type NOT IN('ASSET','ASSET_LOCATION') OR destination_account.normal_side<>'DEBIT' OR destination_account.archived_at IS NOT NULL OR left(destination_account.code,13)='CASH_CUSTODY_'
  OR NOT original.sealed OR original.reverses_transaction_id IS NOT NULL OR EXISTS(SELECT 1 FROM financial_transaction r WHERE r.organization_id=organization_uuid AND r.reverses_transaction_id=original.id)
  OR amount<=0 OR proof.after->>'currency' IS DISTINCT FROM receipt.currency OR NOT EXISTS(SELECT 1 FROM currency c WHERE c.code=receipt.currency AND c.minor_unit<=2 AND amount=round(amount,c.minor_unit))
 THEN RAISE EXCEPTION 'cash_handover_actual_active_locations_required';END IF;
 expected_dimensions:=jsonb_build_object('transfer_id',request_uuid::text,'from_account_id',source_account.id::text,'to_account_id',destination_account.id::text,'kind','CUSTODY_HANDOVER','source','TRANSFER','custody_collection_id',receipt.id::text);
 IF(SELECT count(*) FROM posting p WHERE p.organization_id=organization_uuid AND p.transaction_id=journal.id)<>2
  OR EXISTS(SELECT 1 FROM posting p WHERE p.organization_id=organization_uuid AND p.transaction_id=journal.id AND(p.amount<>amount OR p.currency<>receipt.currency OR p.bucket IS DISTINCT FROM 'CUSTODY_HANDOVER' OR p.dimensions IS DISTINCT FROM expected_dimensions OR p.side='DEBIT' AND p.ledger_account_id<>destination_account.id OR p.side='CREDIT' AND p.ledger_account_id<>source_account.id))
 THEN RAISE EXCEPTION 'cash_handover_exact_native_movements_required';END IF;
 -- Both application admission and posting birth serialize the actual account.
 -- Derived amounts include original receipts, handovers and exact reversals.
 PERFORM 1 FROM ledger_account WHERE organization_id=organization_uuid AND id=source_account.id FOR UPDATE;
 SELECT COALESCE(sum(CASE WHEN p.side='DEBIT' THEN p.amount ELSE -p.amount END),0) INTO remaining FROM posting p JOIN financial_transaction j ON j.organization_id=p.organization_id AND j.id=p.transaction_id WHERE p.organization_id=organization_uuid AND p.ledger_account_id=source_account.id AND p.currency=receipt.currency AND j.sealed AND(j.id=receipt.transaction_id OR j.reverses_transaction_id=receipt.transaction_id OR p.dimensions->>'custody_collection_id'=receipt.id::text);
 IF remaining<0 OR remaining>receipt.amount THEN RAISE EXCEPTION 'cash_handover_exceeds_original_outstanding_custody';END IF;
END $$;
