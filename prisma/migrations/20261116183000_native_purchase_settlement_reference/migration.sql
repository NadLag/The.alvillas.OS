-- Qualify the beneficiary variable without changing any settlement invariant.
CREATE OR REPLACE FUNCTION app_expense_settlement_birth() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE root uuid; beneficiary_uuid uuid; nonce text; p expense_purchase; e expense; owed numeric; advance numeric; credit posting; liability posting;
BEGIN
 IF NOT NEW.sealed OR NEW.reference NOT LIKE 'EXPENSE-SETTLEMENT:%' THEN RETURN NEW; END IF;
 SELECT (x.dimensions->>'employee_expense_claim_id')::uuid,(x.dimensions->>'employee_person_id')::uuid,x.dimensions->>'employee_expense_settlement_id' INTO STRICT root,beneficiary_uuid,nonce FROM posting x WHERE x.organization_id=NEW.organization_id AND x.transaction_id=NEW.id LIMIT 1;
 SELECT * INTO STRICT p FROM expense_purchase WHERE organization_id=NEW.organization_id AND expense_id=root AND funding_kind='PERSONAL' AND purchaser_id=beneficiary_uuid;
 SELECT * INTO STRICT e FROM expense WHERE organization_id=NEW.organization_id AND id=root;
 IF NEW.reverses_transaction_id IS NOT NULL THEN
   IF NOT EXISTS(SELECT 1 FROM audit_log l WHERE l.organization_id=NEW.organization_id AND l.resource_id=NEW.reverses_transaction_id AND l.action='expense.personal_settlement.reversed' AND l.actor_id=NEW.created_by AND l.after->'reversalTransactionIds' ? NEW.id::text)
   THEN RAISE EXCEPTION 'expense_settlement_reversal_receipt_required' USING ERRCODE='23514'; END IF;
   RETURN NEW;
 END IF;
 SELECT * INTO STRICT liability FROM posting x WHERE x.organization_id=NEW.organization_id AND x.transaction_id=NEW.id AND x.side='DEBIT' AND x.ledger_account_id=e.funding_account_id;
 SELECT * INTO STRICT credit FROM posting x WHERE x.organization_id=NEW.organization_id AND x.transaction_id=NEW.id AND x.side='CREDIT';
 IF (SELECT count(*) FROM posting x WHERE x.organization_id=NEW.organization_id AND x.transaction_id=NEW.id)<>2 OR liability.amount<>credit.amount OR liability.currency<>e.currency OR credit.currency<>e.currency OR liability.dimensions<>credit.dimensions
 OR credit.bucket NOT IN('PERSONAL_EXPENSE_PAYMENT','PERSONAL_EXPENSE_OFFSET') OR credit.bucket IS DISTINCT FROM liability.bucket
 OR NOT EXISTS(SELECT 1 FROM ledger_account l WHERE l.organization_id=NEW.organization_id AND l.id=credit.ledger_account_id AND l.normal_side='DEBIT' AND l.account_type IN('ASSET','ASSET_LOCATION','STAFF_WALLET') AND l.code NOT LIKE 'CASH_CUSTODY_%' AND l.archived_at IS NULL)
 OR NOT EXISTS(SELECT 1 FROM audit_log l WHERE l.organization_id=NEW.organization_id AND l.resource_id=NEW.id AND l.resource_type='financial_transaction' AND l.action='expense.personal_settlement.posted' AND l.actor_id=NEW.created_by)
 THEN RAISE EXCEPTION 'expense_settlement_original_source_required' USING ERRCODE='23514'; END IF;
 SELECT COALESCE(SUM(CASE WHEN x.side='CREDIT' THEN x.amount ELSE -x.amount END),0) INTO owed FROM posting x JOIN ledger_account l ON l.organization_id=x.organization_id AND l.id=x.ledger_account_id WHERE x.organization_id=NEW.organization_id AND x.currency=e.currency AND l.code='EMPLOYEE_PAYABLE' AND x.dimensions->>'employee_expense_claim_id'=root::text AND x.dimensions->>'employee_person_id'=beneficiary_uuid::text;
 IF owed<0 THEN RAISE EXCEPTION 'expense_settlement_exceeds_outstanding' USING ERRCODE='23514'; END IF;
 IF credit.bucket='PERSONAL_EXPENSE_OFFSET' AND NOT EXISTS(SELECT 1 FROM team_wallet w WHERE w.organization_id=NEW.organization_id AND w.person_id=beneficiary_uuid AND w.ledger_account_id=credit.ledger_account_id)
 OR credit.bucket='PERSONAL_EXPENSE_PAYMENT' AND EXISTS(SELECT 1 FROM team_wallet w WHERE w.organization_id=NEW.organization_id AND w.person_id=beneficiary_uuid AND w.ledger_account_id=credit.ledger_account_id)
 THEN RAISE EXCEPTION 'expense_settlement_actual_beneficiary_wallet_required' USING ERRCODE='23514'; END IF;
 SELECT COALESCE(SUM(CASE WHEN x.side='DEBIT' THEN x.amount ELSE -x.amount END),0) INTO advance FROM team_wallet w JOIN posting x ON x.organization_id=w.organization_id AND x.ledger_account_id=w.ledger_account_id WHERE w.organization_id=NEW.organization_id AND w.person_id=beneficiary_uuid AND x.currency=e.currency;
 IF credit.bucket='PERSONAL_EXPENSE_PAYMENT' AND advance>0 OR credit.bucket='PERSONAL_EXPENSE_OFFSET' AND advance<0 THEN RAISE EXCEPTION 'expense_settlement_allocate_verified_advance_first' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
