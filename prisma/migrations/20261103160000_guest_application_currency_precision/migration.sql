BEGIN;

CREATE FUNCTION app_guard_guest_application_currency() RETURNS trigger
 LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM currency c WHERE c.code=NEW.currency AND c.minor_unit BETWEEN 0 AND 2
  AND NEW.amount=round(NEW.amount,c.minor_unit)) THEN
  RAISE EXCEPTION 'guest_application_exact_currency_precision_required'; END IF;
 RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER guest_application_currency_guard AFTER INSERT ON posting
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
 WHEN (NEW.dimensions->>'application_source'='ORIGINAL_GUEST_PREPAYMENT'
  AND NEW.dimensions->>'deposit_operation' IN('APPLICATION','APPLICATION_ADJUSTMENT'))
 EXECUTE FUNCTION app_guard_guest_application_currency();

COMMIT;
