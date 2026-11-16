-- Keep the original purchase record distinct from joined source aliases.
-- Settlement provenance must not impersonate native expense-cost postings.
-- Retain actual expense/correction provenance in every new payable settlement.
-- Qualify the beneficiary variable without changing any settlement invariant.
CREATE OR REPLACE FUNCTION app_expense_settlement_birth() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE root uuid; beneficiary_uuid uuid; nonce text; original_purchase expense_purchase; e expense; owed numeric; advance numeric; credit posting; liability posting; source_expense expense;
BEGIN
 IF NOT NEW.sealed OR NEW.reference NOT LIKE 'EXPENSE-SETTLEMENT:%' THEN RETURN NEW; END IF;
 SELECT (x.dimensions->>'employee_expense_claim_id')::uuid,(x.dimensions->>'employee_person_id')::uuid,x.dimensions->>'employee_expense_settlement_id' INTO STRICT root,beneficiary_uuid,nonce FROM posting x WHERE x.organization_id=NEW.organization_id AND x.transaction_id=NEW.id LIMIT 1;
 SELECT * INTO STRICT original_purchase FROM expense_purchase WHERE organization_id=NEW.organization_id AND expense_id=root AND funding_kind='PERSONAL' AND purchaser_id=beneficiary_uuid;
 SELECT * INTO STRICT e FROM expense WHERE organization_id=NEW.organization_id AND id=root;
 IF NEW.reverses_transaction_id IS NOT NULL THEN
   IF NOT EXISTS(SELECT 1 FROM audit_log l WHERE l.organization_id=NEW.organization_id AND l.resource_id=NEW.reverses_transaction_id AND l.action='expense.personal_settlement.reversed' AND l.actor_id=NEW.created_by AND l.after->'reversalTransactionIds' ? NEW.id::text)
   THEN RAISE EXCEPTION 'expense_settlement_reversal_receipt_required' USING ERRCODE='23514'; END IF;
   RETURN NEW;
 END IF;
 SELECT * INTO STRICT liability FROM posting x WHERE x.organization_id=NEW.organization_id AND x.transaction_id=NEW.id AND x.side='DEBIT' AND x.ledger_account_id=e.funding_account_id;
 SELECT * INTO STRICT credit FROM posting x WHERE x.organization_id=NEW.organization_id AND x.transaction_id=NEW.id AND x.side='CREDIT';
 SELECT s.* INTO STRICT source_expense FROM expense s JOIN expense_purchase p ON p.organization_id=s.organization_id AND p.expense_id=s.id JOIN financial_transaction j ON j.organization_id=s.organization_id AND j.id=s.transaction_id
  WHERE s.organization_id=NEW.organization_id AND s.id::text=credit.dimensions->>'personal_expense_source_id' AND p.root_expense_id=root AND p.purchaser_id=beneficiary_uuid AND p.funding_kind='PERSONAL' AND s.state='POSTED' AND s.funding_account_id=e.funding_account_id AND s.currency=e.currency AND j.sealed AND j.reverses_transaction_id IS NULL AND NOT EXISTS(SELECT 1 FROM financial_transaction r WHERE r.organization_id=j.organization_id AND r.reverses_transaction_id=j.id);
 IF NEW.reference<>'EXPENSE-SETTLEMENT:'||nonce OR NEW.idempotency_key<>'expense-personal-settlement:'||nonce
 OR NOT EXISTS(SELECT 1 FROM audit_log l WHERE l.organization_id=NEW.organization_id AND l.resource_id=NEW.id AND l.action='expense.personal_settlement.posted' AND l.after->>'transactionId'=NEW.id::text AND l.after#>>'{input,expenseId}'=source_expense.id::text AND l.after#>>'{input,idempotencyKey}'=nonce AND l.after#>>'{input,fundingAccountId}'=credit.ledger_account_id::text AND (l.after#>>'{input,amount}')::numeric=credit.amount AND l.after#>>'{input,currency}'=credit.currency AND l.after#>>'{input,kind}'=CASE WHEN credit.bucket='PERSONAL_EXPENSE_OFFSET' THEN 'WALLET_OFFSET' ELSE 'PAYMENT' END)
 THEN RAISE EXCEPTION 'expense_settlement_actual_expense_and_receipt_required' USING ERRCODE='23514'; END IF;
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
