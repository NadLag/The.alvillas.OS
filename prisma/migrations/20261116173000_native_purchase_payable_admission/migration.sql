-- Preserve every compensation/correction guard and admit only native,
-- independently guarded personal-expense sources to the same payable account.
CREATE OR REPLACE FUNCTION public.app_employee_recognition_posting_guard()
 RETURNS trigger LANGUAGE plpgsql AS $function$
DECLARE link_uuid uuid; correction_uuid uuid;
BEGIN
 IF EXISTS(SELECT 1 FROM financial_transaction t JOIN employee_compensation_recognition_line l ON l.organization_id=t.organization_id AND l.transaction_id=t.reverses_transaction_id WHERE t.organization_id=NEW.organization_id AND t.id=NEW.transaction_id) THEN
  SELECT link.correction_id INTO correction_uuid FROM employee_compensation_correction_line link
   WHERE link.organization_id=NEW.organization_id AND link.reversal_transaction_id=NEW.transaction_id AND link.cost_id::text=NEW.dimensions->>'employee_compensation_cost_id';
  IF correction_uuid IS NULL THEN RAISE EXCEPTION 'employee recognition opposites require their actual typed original correction';END IF;
  PERFORM app_assert_employee_correction(NEW.organization_id,correction_uuid);RETURN NEW;
 END IF;
 IF NEW.dimensions->>'source' IN ('EMPLOYEE_PAYMENT','EMPLOYEE_COMPENSATION_OFFSET') OR NEW.bucket IN ('EMPLOYEE_PAYMENT','COMPENSATION_OFFSET') THEN
  PERFORM app_assert_employee_settlement(NEW.organization_id,NEW.transaction_id);RETURN NEW;END IF;
 IF NEW.dimensions ? 'employee_expense_claim_id' THEN
  IF NEW.dimensions ? 'employee_compensation_claim_id' OR NEW.dimensions->>'source'='EMPLOYEE_COMPENSATION' OR NEW.bucket='EMPLOYEE_COMPENSATION'
  OR NOT EXISTS(SELECT 1 FROM expense_purchase p JOIN expense e ON e.organization_id=p.organization_id AND e.id=p.expense_id
   JOIN financial_transaction t ON t.organization_id=p.organization_id AND t.id=NEW.transaction_id
   WHERE p.organization_id=NEW.organization_id AND p.funding_kind='PERSONAL'
   AND p.root_expense_id::text=NEW.dimensions->>'employee_expense_claim_id' AND p.purchaser_id::text=NEW.dimensions->>'employee_person_id'
   AND ((NEW.dimensions->>'source'='EXPENSE' AND NEW.dimensions->>'expense_id'=e.id::text AND (e.transaction_id=t.id OR e.transaction_id=t.reverses_transaction_id) AND t.reference='EXPENSE:'||e.id::text||CASE WHEN t.reverses_transaction_id IS NULL THEN '' ELSE ':VOID' END)
    OR (NEW.dimensions->>'source' IN('EMPLOYEE_EXPENSE_PAYMENT','EMPLOYEE_EXPENSE_OFFSET') AND t.reference ~ '^EXPENSE-SETTLEMENT:[0-9a-f-]{36}(:VOID)?$')))
  THEN RAISE EXCEPTION 'employee personal expense postings require their actual native source'; END IF;
  RETURN NEW;
 END IF;
 IF NEW.dimensions->>'source' IS DISTINCT FROM 'EMPLOYEE_COMPENSATION' AND NEW.bucket IS DISTINCT FROM 'EMPLOYEE_COMPENSATION'
  AND NOT COALESCE(NEW.dimensions ? 'employee_compensation_claim_id',false)
  AND NOT EXISTS(SELECT 1 FROM ledger_account a WHERE a.organization_id=NEW.organization_id AND a.id=NEW.ledger_account_id AND a.code='EMPLOYEE_PAYABLE') THEN RETURN NEW;END IF;
 SELECT id INTO link_uuid FROM employee_compensation_recognition_line WHERE organization_id=NEW.organization_id AND transaction_id=NEW.transaction_id AND cost_id::text=NEW.dimensions->>'employee_compensation_cost_id';
 IF link_uuid IS NULL THEN RAISE EXCEPTION 'employee recognition postings require their actual atomic source';END IF;
 PERFORM app_assert_employee_recognition_line(NEW.organization_id,link_uuid);RETURN NEW;
END $function$;
