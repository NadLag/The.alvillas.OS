BEGIN;

CREATE INDEX cash_source_ownership_history_idx ON posting
 (organization_id,lower(coalesce(dimensions->>'cash_collection_id',dimensions->>'cashCollectionId')),ledger_account_id,currency,id)
 WHERE dimensions ? 'cash_collection_id' OR dimensions ? 'cashCollectionId';

CREATE FUNCTION app_guard_original_cash_source_budget() RETURNS trigger
 LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE
 account_code text; identity_text text; collection_uuid uuid;
 journal financial_transaction%ROWTYPE; collection cash_collection%ROWTYPE;
 remaining numeric;
BEGIN
 SELECT a.code INTO account_code FROM ledger_account a
  WHERE a.organization_id=NEW.organization_id AND a.id=NEW.ledger_account_id;
 IF account_code IS DISTINCT FROM 'UNALLOCATED_COLLECTIONS' THEN RETURN NEW; END IF;
 SELECT t.* INTO journal FROM financial_transaction t
  WHERE t.organization_id=NEW.organization_id AND t.id=NEW.transaction_id;
 IF NOT FOUND OR NOT journal.sealed THEN RAISE EXCEPTION 'cash_source_sealed_journal_required'; END IF;
 identity_text:=coalesce(NEW.dimensions->>'cash_collection_id',NEW.dimensions->>'cashCollectionId');
 IF NEW.dimensions ? 'cash_collection_id' AND NEW.dimensions ? 'cashCollectionId'
  AND lower(NEW.dimensions->>'cash_collection_id') IS DISTINCT FROM lower(NEW.dimensions->>'cashCollectionId') THEN
  RAISE EXCEPTION 'cash_source_identity_mismatch';
 END IF;
 IF identity_text IS NULL OR identity_text !~* '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$' THEN
  -- Existing history can still receive its exact native opposite.
  IF journal.reverses_transaction_id IS NOT NULL AND EXISTS(
   SELECT 1 FROM posting p WHERE p.organization_id=NEW.organization_id
    AND p.transaction_id=journal.reverses_transaction_id AND p.ledger_account_id=NEW.ledger_account_id
    AND p.amount=NEW.amount AND p.currency=NEW.currency AND p.side<>NEW.side
    AND p.bucket IS NOT DISTINCT FROM NEW.bucket AND p.dimensions IS NOT DISTINCT FROM NEW.dimensions
  ) THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'cash_source_original_collection_required';
 END IF;
 collection_uuid:=identity_text::uuid;
 PERFORM pg_advisory_xact_lock(hashtextextended(NEW.organization_id::text||':financial-transfer:cash-source:'||collection_uuid::text,0));
 SELECT c.* INTO collection FROM cash_collection c
  WHERE c.organization_id=NEW.organization_id AND c.id=collection_uuid;
 IF NOT FOUND OR NEW.currency<>collection.currency OR NOT EXISTS(
  SELECT 1 FROM financial_transaction t JOIN posting p ON p.organization_id=t.organization_id AND p.transaction_id=t.id
  JOIN ledger_account a ON a.organization_id=p.organization_id AND a.id=p.ledger_account_id
  WHERE t.organization_id=collection.organization_id AND t.id=collection.transaction_id AND t.sealed
   AND t.reference='CASH:'||collection.id::text AND p.side='CREDIT' AND p.amount=collection.amount
   AND p.currency=collection.currency AND a.code='UNALLOCATED_COLLECTIONS'
   AND coalesce(p.dimensions->>'cashCollectionId',p.dimensions->>'cash_collection_id')=collection.id::text
 ) THEN RAISE EXCEPTION 'cash_source_actual_receipt_required'; END IF;
 IF NEW.side='CREDIT' AND journal.id<>collection.transaction_id AND journal.reverses_transaction_id IS NULL THEN
  RAISE EXCEPTION 'cash_source_no_duplicate_receipt';
 END IF;
 SELECT coalesce(sum(CASE p.side WHEN 'CREDIT' THEN p.amount ELSE -p.amount END),0) INTO remaining
  FROM posting p WHERE p.organization_id=NEW.organization_id AND p.ledger_account_id=NEW.ledger_account_id
   AND p.currency=collection.currency
   AND(p.dimensions ? 'cash_collection_id' OR p.dimensions ? 'cashCollectionId')
   AND lower(coalesce(p.dimensions->>'cash_collection_id',p.dimensions->>'cashCollectionId'))=collection.id::text;
 IF remaining<0 OR remaining>collection.amount THEN RAISE EXCEPTION 'cash_source_original_budget_exceeded'; END IF;
 RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER original_cash_source_budget AFTER INSERT ON posting
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app_guard_original_cash_source_budget();

COMMIT;
