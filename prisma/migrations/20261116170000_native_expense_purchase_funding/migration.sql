-- Native expense evidence and the existing EMPLOYEE_PAYABLE account represent
-- personally funded purchases. No cash, balances or historical rows are edited.
CREATE TABLE expense_purchase(
 organization_id uuid NOT NULL REFERENCES organization(id) ON DELETE RESTRICT,
 expense_id uuid NOT NULL,root_expense_id uuid NOT NULL,funding_kind text NOT NULL,
 purchaser_id uuid NOT NULL,supplier_id uuid NOT NULL,receipt_version_id uuid NOT NULL,
 created_by uuid NOT NULL,created_at timestamptz(6) NOT NULL,
 CONSTRAINT expense_purchase_pkey PRIMARY KEY(organization_id,expense_id),
 CONSTRAINT expense_purchase_expense_fk FOREIGN KEY(organization_id,expense_id) REFERENCES expense(organization_id,id) ON DELETE RESTRICT,
 CONSTRAINT expense_purchase_root_fk FOREIGN KEY(organization_id,root_expense_id) REFERENCES expense(organization_id,id) ON DELETE RESTRICT,
 CONSTRAINT expense_purchase_person_fk FOREIGN KEY(organization_id,purchaser_id) REFERENCES person(organization_id,id) ON DELETE RESTRICT,
 CONSTRAINT expense_purchase_supplier_fk FOREIGN KEY(organization_id,supplier_id) REFERENCES supplier(organization_id,id) ON DELETE RESTRICT,
 CONSTRAINT expense_purchase_receipt_fk FOREIGN KEY(organization_id,receipt_version_id) REFERENCES document_version(organization_id,id) ON DELETE RESTRICT,
 CONSTRAINT expense_purchase_actor_fk FOREIGN KEY(organization_id,created_by) REFERENCES user_account(organization_id,id) ON DELETE RESTRICT,
 CONSTRAINT expense_purchase_kind_check CHECK(funding_kind IN('COMPANY','PERSONAL'))
);
CREATE INDEX expense_purchase_root_idx ON expense_purchase(organization_id,root_expense_id);
ALTER TABLE expense_purchase ENABLE ROW LEVEL SECURITY;
ALTER TABLE expense_purchase FORCE ROW LEVEL SECURITY;
CREATE POLICY expense_purchase_tenant_isolation ON expense_purchase USING(organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid) WITH CHECK(organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid);
CREATE TRIGGER expense_purchase_immutable BEFORE UPDATE OR DELETE ON expense_purchase FOR EACH ROW EXECUTE FUNCTION app_onboarding_append_only();

CREATE FUNCTION app_expense_purchase_scope() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM expense_purchase p WHERE p.organization_id=OLD.organization_id AND p.expense_id=OLD.id)
 AND (NEW.property_id IS DISTINCT FROM OLD.property_id OR NEW.reservation_id IS DISTINCT FROM OLD.reservation_id OR NEW.funding_account_id IS DISTINCT FROM OLD.funding_account_id)
 THEN RAISE EXCEPTION 'expense_purchase_source_immutable' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER expense_purchase_scope_guard BEFORE UPDATE ON expense FOR EACH ROW EXECUTE FUNCTION app_expense_purchase_scope();

CREATE FUNCTION app_expense_purchase_birth() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE e expense; d document; v document_version; a document_admission;
BEGIN
 SELECT * INTO STRICT e FROM expense WHERE organization_id=NEW.organization_id AND id=NEW.expense_id;
 SELECT * INTO STRICT v FROM document_version WHERE organization_id=NEW.organization_id AND id=NEW.receipt_version_id;
 SELECT * INTO STRICT d FROM document WHERE organization_id=NEW.organization_id AND id=v.document_id;
 SELECT * INTO STRICT a FROM document_admission WHERE organization_id=NEW.organization_id AND id=v.admission_id;
 IF e.created_by<>NEW.created_by OR NOT EXISTS(SELECT 1 FROM expense x WHERE x.organization_id=NEW.organization_id AND x.id=e.id AND x.xmin::text=pg_current_xact_id()::text)
 OR d.kind<>'FILE' OR NOT('financial'=ANY(d.privacy)) OR d.archived_at IS NOT NULL
 OR NOT(d.source_kind='PROPERTY' AND d.source_id=e.property_id OR d.source_kind='RESERVATION' AND d.source_id=e.reservation_id)
 OR a.content_type NOT IN('application/pdf','image/jpeg','image/png','image/webp')
 OR EXISTS(SELECT 1 FROM document_version n WHERE n.organization_id=NEW.organization_id AND n.supersedes_id=v.id)
 OR NOT EXISTS(SELECT 1 FROM audit_log l WHERE l.organization_id=NEW.organization_id AND l.resource_type='expense' AND l.resource_id=e.id AND l.action='expense.created' AND l.actor_id=NEW.created_by)
 OR NEW.root_expense_id<>COALESCE((SELECT p.root_expense_id FROM expense_purchase p WHERE p.organization_id=NEW.organization_id AND p.expense_id=e.corrects_expense_id),e.id)
 THEN RAISE EXCEPTION 'expense_purchase_original_evidence_required' USING ERRCODE='23514'; END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER expense_purchase_birth_guard AFTER INSERT ON expense_purchase DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app_expense_purchase_birth();

CREATE FUNCTION app_expense_purchase_funding() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE e expense; p expense_purchase; a ledger_account; owed numeric;
BEGIN
 SELECT * INTO STRICT e FROM expense WHERE organization_id=NEW.organization_id AND id=NEW.id;
 SELECT * INTO STRICT a FROM ledger_account WHERE organization_id=e.organization_id AND id=e.funding_account_id;
 SELECT * INTO p FROM expense_purchase WHERE organization_id=e.organization_id AND expense_id=e.id;
 IF a.code='EMPLOYEE_PAYABLE' AND (p.expense_id IS NULL OR p.funding_kind<>'PERSONAL') OR p.funding_kind='PERSONAL' AND (a.code<>'EMPLOYEE_PAYABLE' OR a.account_type<>'CLAIM_OWNERSHIP' OR a.normal_side<>'CREDIT')
 OR p.funding_kind='COMPANY' AND (a.normal_side<>'DEBIT' OR a.account_type NOT IN('ASSET','ASSET_LOCATION','STAFF_WALLET') OR a.code LIKE 'CASH_CUSTODY_%')
 THEN RAISE EXCEPTION 'expense_purchase_funding_mismatch' USING ERRCODE='23514'; END IF;
 IF p.funding_kind='PERSONAL' AND e.transaction_id IS NOT NULL THEN
   IF EXISTS(SELECT 1 FROM posting x WHERE x.organization_id=e.organization_id AND x.transaction_id=e.transaction_id AND (x.dimensions->>'employee_person_id' IS DISTINCT FROM p.purchaser_id::text OR x.dimensions->>'employee_expense_claim_id' IS DISTINCT FROM p.root_expense_id::text))
   THEN RAISE EXCEPTION 'expense_purchase_claim_binding_required' USING ERRCODE='23514'; END IF;
   SELECT COALESCE(SUM(CASE WHEN x.side='CREDIT' THEN x.amount ELSE -x.amount END),0) INTO owed FROM posting x JOIN ledger_account l ON l.organization_id=x.organization_id AND l.id=x.ledger_account_id WHERE x.organization_id=e.organization_id AND x.currency=e.currency AND l.code='EMPLOYEE_PAYABLE' AND x.dimensions->>'employee_expense_claim_id'=p.root_expense_id::text AND x.dimensions->>'employee_person_id'=p.purchaser_id::text;
   IF owed<0 THEN RAISE EXCEPTION 'expense_purchase_reverse_settlements_first' USING ERRCODE='23514'; END IF;
 END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER expense_purchase_funding_guard AFTER INSERT OR UPDATE ON expense DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app_expense_purchase_funding();

CREATE FUNCTION app_expense_settlement_birth() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE root uuid; person_id uuid; nonce text; p expense_purchase; e expense; owed numeric; advance numeric; credit posting; liability posting;
BEGIN
 IF NOT NEW.sealed OR NEW.reference NOT LIKE 'EXPENSE-SETTLEMENT:%' THEN RETURN NEW; END IF;
 SELECT (x.dimensions->>'employee_expense_claim_id')::uuid,(x.dimensions->>'employee_person_id')::uuid,x.dimensions->>'employee_expense_settlement_id' INTO STRICT root,person_id,nonce FROM posting x WHERE x.organization_id=NEW.organization_id AND x.transaction_id=NEW.id LIMIT 1;
 SELECT * INTO STRICT p FROM expense_purchase WHERE organization_id=NEW.organization_id AND expense_id=root AND funding_kind='PERSONAL' AND purchaser_id=person_id;
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
 SELECT COALESCE(SUM(CASE WHEN x.side='CREDIT' THEN x.amount ELSE -x.amount END),0) INTO owed FROM posting x JOIN ledger_account l ON l.organization_id=x.organization_id AND l.id=x.ledger_account_id WHERE x.organization_id=NEW.organization_id AND x.currency=e.currency AND l.code='EMPLOYEE_PAYABLE' AND x.dimensions->>'employee_expense_claim_id'=root::text AND x.dimensions->>'employee_person_id'=person_id::text;
 IF owed<0 THEN RAISE EXCEPTION 'expense_settlement_exceeds_outstanding' USING ERRCODE='23514'; END IF;
 IF credit.bucket='PERSONAL_EXPENSE_OFFSET' AND NOT EXISTS(SELECT 1 FROM team_wallet w WHERE w.organization_id=NEW.organization_id AND w.person_id=person_id AND w.ledger_account_id=credit.ledger_account_id)
 OR credit.bucket='PERSONAL_EXPENSE_PAYMENT' AND EXISTS(SELECT 1 FROM team_wallet w WHERE w.organization_id=NEW.organization_id AND w.person_id=person_id AND w.ledger_account_id=credit.ledger_account_id)
 THEN RAISE EXCEPTION 'expense_settlement_actual_beneficiary_wallet_required' USING ERRCODE='23514'; END IF;
 SELECT COALESCE(SUM(CASE WHEN x.side='DEBIT' THEN x.amount ELSE -x.amount END),0) INTO advance FROM team_wallet w JOIN posting x ON x.organization_id=w.organization_id AND x.ledger_account_id=w.ledger_account_id WHERE w.organization_id=NEW.organization_id AND w.person_id=person_id AND x.currency=e.currency;
 IF credit.bucket='PERSONAL_EXPENSE_PAYMENT' AND advance>0 OR credit.bucket='PERSONAL_EXPENSE_OFFSET' AND advance<0 THEN RAISE EXCEPTION 'expense_settlement_allocate_verified_advance_first' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER expense_settlement_birth_guard AFTER INSERT OR UPDATE ON financial_transaction DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app_expense_settlement_birth();

CREATE FUNCTION app_expense_claim_posting() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE root text; person_id text; reference text;
BEGIN
 root:=NEW.dimensions->>'employee_expense_claim_id';
 IF root IS NULL THEN RETURN NEW; END IF;
 person_id:=NEW.dimensions->>'employee_person_id';
 PERFORM pg_advisory_xact_lock(hashtextextended(NEW.organization_id::text||':employee-settlement:'||root,0));
 SELECT t.reference INTO STRICT reference FROM financial_transaction t WHERE t.organization_id=NEW.organization_id AND t.id=NEW.transaction_id;
 IF NOT EXISTS(SELECT 1 FROM expense_purchase p WHERE p.organization_id=NEW.organization_id AND p.expense_id::text=root AND p.purchaser_id::text=person_id AND p.funding_kind='PERSONAL')
 OR NOT(reference ~ '^EXPENSE:[0-9a-f-]{36}(:VOID)?$' OR reference ~ '^EXPENSE-SETTLEMENT:[0-9a-f-]{36}(:VOID)?$')
 THEN RAISE EXCEPTION 'expense_claim_native_source_required' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER expense_claim_posting_guard BEFORE INSERT ON posting FOR EACH ROW EXECUTE FUNCTION app_expense_claim_posting();
