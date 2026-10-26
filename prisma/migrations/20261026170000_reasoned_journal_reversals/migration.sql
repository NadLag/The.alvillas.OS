BEGIN;

-- Future reversal inserts are checked without changing any existing journal.
CREATE FUNCTION app_financial_reversal_source_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE original financial_transaction%ROWTYPE;
BEGIN
 IF NEW.reverses_transaction_id IS NULL THEN RETURN NEW; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(NEW.organization_id::text||':journal-reversal:'||NEW.reverses_transaction_id::text,0));
 SELECT * INTO original FROM financial_transaction
 WHERE organization_id=NEW.organization_id AND id=NEW.reverses_transaction_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'reversal original journal is unavailable'; END IF;
 IF original.reverses_transaction_id IS NOT NULL THEN RAISE EXCEPTION 'a reversal cannot itself be reversed'; END IF;
 IF NEW.created_by IS NULL OR NOT EXISTS(SELECT 1 FROM user_account WHERE organization_id=NEW.organization_id AND id=NEW.created_by)
 THEN RAISE EXCEPTION 'reversal actor is unavailable'; END IF;
 IF EXISTS(SELECT 1 FROM financial_transaction WHERE organization_id=NEW.organization_id AND reverses_transaction_id=original.id)
 THEN RAISE EXCEPTION 'original journal is already reversed'; END IF;
 RETURN NEW;
END $$;

CREATE TRIGGER financial_reversal_source_guard BEFORE INSERT ON financial_transaction
 FOR EACH ROW EXECUTE FUNCTION app_financial_reversal_source_guard();

CREATE FUNCTION app_financial_reversal_integrity_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.reverses_transaction_id IS NULL THEN RETURN NEW; END IF;
 IF EXISTS(SELECT 1 FROM (
  (SELECT ledger_account_id,CASE side WHEN 'DEBIT' THEN 'CREDIT' ELSE 'DEBIT' END AS side,amount,currency,bucket,
    COALESCE(dimensions,'{}'::jsonb)-'posting_kind'-'reversal_of_transaction_id' AS economic_dimensions
   FROM posting WHERE organization_id=NEW.organization_id AND transaction_id=NEW.reverses_transaction_id
   EXCEPT ALL
   SELECT ledger_account_id,side,amount,currency,bucket,COALESCE(dimensions,'{}'::jsonb)-'posting_kind'-'reversal_of_transaction_id'
   FROM posting WHERE organization_id=NEW.organization_id AND transaction_id=NEW.id)
  UNION ALL
  (SELECT ledger_account_id,side,amount,currency,bucket,COALESCE(dimensions,'{}'::jsonb)-'posting_kind'-'reversal_of_transaction_id'
   FROM posting WHERE organization_id=NEW.organization_id AND transaction_id=NEW.id
   EXCEPT ALL
   SELECT ledger_account_id,CASE side WHEN 'DEBIT' THEN 'CREDIT' ELSE 'DEBIT' END AS side,amount,currency,bucket,
    COALESCE(dimensions,'{}'::jsonb)-'posting_kind'-'reversal_of_transaction_id'
   FROM posting WHERE organization_id=NEW.organization_id AND transaction_id=NEW.reverses_transaction_id)
 ) differences) THEN RAISE EXCEPTION 'reversal must be the exact opposite of the original journal'; END IF;
 IF NOT EXISTS(SELECT 1 FROM audit_log a
  WHERE a.organization_id=NEW.organization_id AND a.actor_id=NEW.created_by AND length(btrim(a.reason))>0
   AND (a.after->>'reversalTransactionId'=NEW.id::text OR a.after->'reversalTransactionIds' @> jsonb_build_array(NEW.id::text))
   AND (a.after->>'transactionId'=NEW.reverses_transaction_id::text OR a.after->'originalTransactionIds' @> jsonb_build_array(NEW.reverses_transaction_id::text)))
 THEN RAISE EXCEPTION 'reversal audit must commit atomically'; END IF;
 RETURN NEW;
END $$;

CREATE CONSTRAINT TRIGGER financial_reversal_integrity_guard AFTER INSERT ON financial_transaction
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app_financial_reversal_integrity_guard();

COMMIT;
