BEGIN;
-- A beneficiary retaining their own held cash is an explicit offset, not a disbursement from another location.
-- Existing opposite journals remain permitted so historical records can be corrected without rewriting them.
CREATE FUNCTION app_employee_payment_funding_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.side='CREDIT' AND (NEW.dimensions->>'source'='EMPLOYEE_PAYMENT' OR NEW.bucket='EMPLOYEE_PAYMENT')
  AND EXISTS(SELECT 1 FROM team_wallet w JOIN employee_compensation_claim c ON c.organization_id=w.organization_id AND c.person_id=w.person_id
   WHERE w.organization_id=NEW.organization_id AND w.ledger_account_id=NEW.ledger_account_id AND c.id::text=NEW.dimensions->>'employee_compensation_claim_id')
 THEN RAISE EXCEPTION 'employee beneficiary wallet requires explicit offset mode';END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER employee_payment_funding_guard BEFORE INSERT ON posting FOR EACH ROW EXECUTE FUNCTION app_employee_payment_funding_guard();
COMMIT;
