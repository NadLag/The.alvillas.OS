-- Guard new expense postings without rewriting any existing business or journal row.
CREATE OR REPLACE FUNCTION app_assert_expense_posting(expense_uuid uuid,organization_uuid uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE e expense%ROWTYPE; s expense_submission%ROWTYPE; t financial_transaction%ROWTYPE; reversal financial_transaction%ROWTYPE; policy jsonb;
 owner_amount numeric; company_amount numeric; guest_amount numeric; expected_lines integer:=1;
BEGIN
 SELECT * INTO e FROM expense WHERE organization_id=organization_uuid AND id=expense_uuid;
 IF e.id IS NULL THEN RAISE EXCEPTION 'expense posting requires its tenant source'; END IF;
 IF e.transaction_id IS NULL THEN
  IF EXISTS (SELECT 1 FROM posting WHERE organization_id=organization_uuid AND dimensions->>'expense_id'=expense_uuid::text)
   THEN RAISE EXCEPTION 'expense posting requires its posted source'; END IF;
  RETURN;
 END IF;
 SELECT * INTO s FROM expense_submission WHERE organization_id=organization_uuid AND expense_id=e.id;
 SELECT * INTO t FROM financial_transaction WHERE organization_id=organization_uuid AND id=e.transaction_id;
 IF s.id IS NULL OR t.id IS NULL OR t.idempotency_key<>'expense:'||e.id||':posted' OR t.reference<>'EXPENSE:'||e.id
  OR t.reverses_transaction_id IS NOT NULL OR (t.occurred_at AT TIME ZONE (s.snapshot->>'timezone'))::date<>e.occurred_on
  OR NOT EXISTS (SELECT 1 FROM audit_log a WHERE a.organization_id=organization_uuid AND a.resource_type='expense' AND a.resource_id=e.id
    AND a.action='expense.posted' AND a.actor_id=t.created_by AND a.after->>'transactionId'=t.id::text AND a.after->>'submissionId'=s.id::text)
 THEN RAISE EXCEPTION 'expense posting must retain its approved source and audit'; END IF;
 IF EXISTS (SELECT 1 FROM posting p WHERE p.organization_id=organization_uuid AND p.transaction_id=t.id AND (
    p.currency<>e.currency OR p.dimensions->>'expense_id' IS DISTINCT FROM e.id::text
    OR p.dimensions->>'property_id' IS DISTINCT FROM e.property_id::text OR p.dimensions->>'reservation_id' IS DISTINCT FROM e.reservation_id::text
    OR p.dimensions->>'category' IS DISTINCT FROM e.category OR p.dimensions->>'source' IS DISTINCT FROM 'EXPENSE'))
  OR (SELECT count(*) FROM posting WHERE organization_id=organization_uuid AND transaction_id=t.id AND side='CREDIT')<>1
  OR NOT EXISTS (SELECT 1 FROM posting WHERE organization_id=organization_uuid AND transaction_id=t.id AND side='CREDIT'
    AND ledger_account_id=e.funding_account_id AND amount=e.amount AND bucket='EXPENSE_PAYMENT')
 THEN RAISE EXCEPTION 'expense postings must retain their funding and financial dimensions'; END IF;
 FOR policy IN SELECT value FROM jsonb_array_elements(s.snapshot->'policies') LOOP
  owner_amount=(policy#>>'{allocation,owner,amount}')::numeric;
  IF owner_amount>0 THEN
   expected_lines=expected_lines+1;
   IF (SELECT count(*) FROM posting p JOIN ledger_account a ON a.organization_id=p.organization_id AND a.id=p.ledger_account_id
      WHERE p.organization_id=organization_uuid AND p.transaction_id=t.id AND p.side='DEBIT' AND p.amount=owner_amount
       AND p.bucket='OWNER_EXPENSE' AND p.dimensions->>'owner_id'=policy->>'ownerId'
       AND a.code='OWNER_PAYABLE' AND a.account_type='CLAIM_OWNERSHIP' AND a.normal_side='CREDIT')<>1
    THEN RAISE EXCEPTION 'expense posting must retain each approved owner charge'; END IF;
  END IF;
 END LOOP;
 company_amount=(s.snapshot#>>'{allocation,alvillas,amount}')::numeric;
 guest_amount=(s.snapshot#>>'{allocation,guest,amount}')::numeric;
 IF company_amount>0 THEN
  expected_lines=expected_lines+1;
  IF (SELECT count(*) FROM posting p JOIN ledger_account a ON a.organization_id=p.organization_id AND a.id=p.ledger_account_id
    WHERE p.organization_id=organization_uuid AND p.transaction_id=t.id AND p.side='DEBIT' AND p.amount=company_amount
     AND p.bucket='ALVILLAS_EXPENSE' AND a.code='ALVILLAS_EXPENSE' AND a.account_type='ALVILLAS_OWN' AND a.normal_side='DEBIT')<>1
   THEN RAISE EXCEPTION 'expense posting must retain its approved company charge'; END IF;
 END IF;
 IF guest_amount>0 THEN
  expected_lines=expected_lines+1;
  IF (SELECT count(*) FROM posting p JOIN ledger_account a ON a.organization_id=p.organization_id AND a.id=p.ledger_account_id
    WHERE p.organization_id=organization_uuid AND p.transaction_id=t.id AND p.side='DEBIT' AND p.amount=guest_amount
     AND p.bucket='GUEST_EXPENSE' AND a.code='GUEST_RECEIVABLE' AND a.account_type='CLAIM_OWNERSHIP' AND a.normal_side='DEBIT')<>1
   THEN RAISE EXCEPTION 'expense posting must retain its approved guest charge'; END IF;
 END IF;
 IF (SELECT count(*) FROM posting WHERE organization_id=organization_uuid AND transaction_id=t.id)<>expected_lines
  OR EXISTS (SELECT 1 FROM posting p WHERE p.organization_id=organization_uuid AND p.dimensions->>'expense_id'=e.id::text AND p.transaction_id<>t.id AND NOT EXISTS (SELECT 1 FROM financial_transaction r WHERE r.organization_id=organization_uuid AND r.id=p.transaction_id AND r.reverses_transaction_id=t.id AND e.state='VOIDED'))
 THEN RAISE EXCEPTION 'expense posting cannot contain additional financial movements'; END IF;

 SELECT * INTO reversal FROM financial_transaction WHERE organization_id=organization_uuid AND reverses_transaction_id=t.id ORDER BY id LIMIT 1;
 IF e.state='VOIDED' THEN
  IF reversal.id IS NULL OR (SELECT count(*) FROM financial_transaction WHERE organization_id=organization_uuid AND reverses_transaction_id=t.id)<>1
   OR reversal.idempotency_key<>'expense:'||e.id||':voided' OR reversal.reference<>'EXPENSE:'||e.id||':VOID'
   OR NOT EXISTS (SELECT 1 FROM audit_log a WHERE a.organization_id=organization_uuid AND a.resource_type='expense' AND a.resource_id=e.id
      AND a.action='expense.voided' AND a.actor_id=reversal.created_by AND a.after->>'transactionId'=t.id::text AND a.after->>'reversalTransactionId'=reversal.id::text)
  THEN RAISE EXCEPTION 'expense void requires one attributed mirror journal and audit'; END IF;
  IF EXISTS (
   WITH expected AS (SELECT ledger_account_id,CASE WHEN side='DEBIT' THEN 'CREDIT' ELSE 'DEBIT' END AS side,amount,currency,bucket,dimensions
      FROM posting WHERE organization_id=organization_uuid AND transaction_id=t.id),
    actual AS (SELECT ledger_account_id,side::text,amount,currency,bucket,dimensions FROM posting WHERE organization_id=organization_uuid AND transaction_id=reversal.id)
   (SELECT * FROM expected EXCEPT ALL SELECT * FROM actual) UNION ALL (SELECT * FROM actual EXCEPT ALL SELECT * FROM expected)
  ) THEN RAISE EXCEPTION 'expense void must mirror every original posting exactly'; END IF;
 ELSIF reversal.id IS NOT NULL THEN RAISE EXCEPTION 'expense reversal requires its atomic void state';
 END IF;
END $$;

CREATE FUNCTION app_expense_reversal_integrity_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE expense_uuid uuid;
BEGIN
 IF NEW.reverses_transaction_id IS NOT NULL THEN
  SELECT id INTO expense_uuid FROM expense WHERE organization_id=NEW.organization_id AND transaction_id=NEW.reverses_transaction_id;
  IF expense_uuid IS NOT NULL THEN PERFORM app_assert_expense_posting(expense_uuid,NEW.organization_id); END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER financial_expense_reversal_integrity AFTER INSERT ON financial_transaction
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app_expense_reversal_integrity_guard();
