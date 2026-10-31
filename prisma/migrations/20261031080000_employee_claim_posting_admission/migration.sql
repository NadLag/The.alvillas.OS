BEGIN;
CREATE OR REPLACE FUNCTION app_employee_recognition_posting_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE link_uuid uuid;
BEGIN
 -- Legacy wallet movements may have no source or bucket. Only actual claim markers or the employee liability account enter this guard.
 IF NEW.dimensions->>'source' IS DISTINCT FROM 'EMPLOYEE_COMPENSATION'
  AND NEW.bucket IS DISTINCT FROM 'EMPLOYEE_COMPENSATION'
  AND NOT COALESCE(NEW.dimensions ? 'employee_compensation_claim_id',false)
  AND NOT EXISTS(SELECT 1 FROM ledger_account a WHERE a.organization_id=NEW.organization_id AND a.id=NEW.ledger_account_id AND a.code='EMPLOYEE_PAYABLE')
 THEN RETURN NEW;END IF;
 SELECT id INTO link_uuid FROM employee_compensation_recognition_line WHERE organization_id=NEW.organization_id AND transaction_id=NEW.transaction_id AND cost_id::text=NEW.dimensions->>'employee_compensation_cost_id';
 IF link_uuid IS NULL THEN RAISE EXCEPTION 'employee recognition postings require their actual atomic source';END IF;
 PERFORM app_assert_employee_recognition_line(NEW.organization_id,link_uuid);RETURN NEW;
END $$;
COMMIT;
