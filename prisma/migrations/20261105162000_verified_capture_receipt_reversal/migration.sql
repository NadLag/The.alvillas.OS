BEGIN;

-- A verified provider capture establishes physical money. A bookkeeping opposite
-- cannot stand in for an actual refund or a separately attributed ownership correction.
CREATE FUNCTION app_guard_verified_capture_receipt_reversal() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
  IF NEW.reverses_transaction_id IS NOT NULL AND EXISTS(
    SELECT 1 FROM guest_payment_receipt r
    JOIN external_payment_intent i ON i.organization_id=r.organization_id AND i.idempotency_key=r.deposit_id
    JOIN external_payment_capture c ON c.organization_id=i.organization_id AND c.intent_id=i.id
    WHERE r.organization_id=NEW.organization_id AND r.transaction_id=NEW.reverses_transaction_id)
    THEN RAISE EXCEPTION 'verified external capture requires a verified money movement'; END IF;
  RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER financial_transaction_verified_capture_reversal_guard AFTER INSERT ON financial_transaction
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app_guard_verified_capture_receipt_reversal();

COMMIT;
