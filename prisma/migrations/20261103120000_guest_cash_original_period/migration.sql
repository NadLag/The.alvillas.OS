BEGIN;

CREATE FUNCTION app_guard_guest_cash_original_period() RETURNS trigger
 LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE source_date timestamptz; opposite uuid;
BEGIN
 SELECT c.recorded_at,t.reverses_transaction_id INTO source_date,opposite
  FROM cash_collection c JOIN financial_transaction t ON t.organization_id=c.organization_id AND t.id=NEW.transaction_id
  WHERE c.organization_id=NEW.organization_id AND c.id::text=NEW.dimensions->>'cash_collection_id';
 -- The complete admission guard independently rejects missing source identity.
 IF NOT FOUND THEN RETURN NEW; END IF;
 IF opposite IS NULL AND NOT app_financial_period_is_open(NEW.organization_id,source_date) THEN
  RAISE EXCEPTION USING ERRCODE='23514',CONSTRAINT='financial_period_open',
   MESSAGE='guest cash original collection date is in a closed accounting period';
 END IF;
 RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER guest_cash_original_period AFTER INSERT ON posting
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
 WHEN (NEW.dimensions->>'deposit_operation'='CASH_ADMISSION')
 EXECUTE FUNCTION app_guard_guest_cash_original_period();

COMMIT;
