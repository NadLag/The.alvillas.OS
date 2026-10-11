CREATE TABLE ledger_account (
  id uuid PRIMARY KEY DEFAULT app_uuid_v7(),
  organization_id uuid NOT NULL REFERENCES organization(id) ON DELETE RESTRICT,
  code text NOT NULL,
  name text NOT NULL,
  account_type text NOT NULL,
  normal_side text NOT NULL,
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ledger_account_org_code_unique UNIQUE (organization_id, code),
  CONSTRAINT ledger_account_normal_side_check CHECK (normal_side IN ('DEBIT', 'CREDIT')),
  CONSTRAINT ledger_account_code_format CHECK (code ~ '^[A-Z][A-Z0-9_]{1,63}$')
);

CREATE TABLE financial_transaction (
  id uuid PRIMARY KEY DEFAULT app_uuid_v7(),
  organization_id uuid NOT NULL REFERENCES organization(id) ON DELETE RESTRICT,
  reference text NOT NULL,
  occurred_at timestamptz NOT NULL,
  description text,
  reverses_transaction_id uuid REFERENCES financial_transaction(id) ON DELETE RESTRICT,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT financial_transaction_org_reference_unique UNIQUE (organization_id, reference)
);

CREATE INDEX financial_transaction_org_occurred_idx
  ON financial_transaction (organization_id, occurred_at);

CREATE TABLE posting (
  id uuid PRIMARY KEY DEFAULT app_uuid_v7(),
  organization_id uuid NOT NULL REFERENCES organization(id) ON DELETE RESTRICT,
  transaction_id uuid NOT NULL REFERENCES financial_transaction(id) ON DELETE RESTRICT,
  ledger_account_id uuid NOT NULL REFERENCES ledger_account(id) ON DELETE RESTRICT,
  side text NOT NULL,
  amount numeric(18, 2) NOT NULL,
  currency char(3) NOT NULL REFERENCES currency(code) ON DELETE RESTRICT,
  bucket text,
  dimensions jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT posting_side_check CHECK (side IN ('DEBIT', 'CREDIT')),
  CONSTRAINT posting_positive_amount CHECK (amount > 0)
);

CREATE INDEX posting_org_transaction_idx
  ON posting (organization_id, transaction_id);

CREATE INDEX posting_org_account_idx
  ON posting (organization_id, ledger_account_id);

CREATE OR REPLACE FUNCTION app_prevent_ledger_mutation()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'ledger rows are append-only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER financial_transaction_no_update
BEFORE UPDATE ON financial_transaction
FOR EACH ROW EXECUTE FUNCTION app_prevent_ledger_mutation();

CREATE TRIGGER financial_transaction_no_delete
BEFORE DELETE ON financial_transaction
FOR EACH ROW EXECUTE FUNCTION app_prevent_ledger_mutation();

CREATE TRIGGER posting_no_update
BEFORE UPDATE ON posting
FOR EACH ROW EXECUTE FUNCTION app_prevent_ledger_mutation();

CREATE TRIGGER posting_no_delete
BEFORE DELETE ON posting
FOR EACH ROW EXECUTE FUNCTION app_prevent_ledger_mutation();

CREATE OR REPLACE FUNCTION app_assert_posting_organization_consistency()
RETURNS trigger AS $$
DECLARE
  transaction_org uuid;
  account_org uuid;
BEGIN
  SELECT organization_id INTO transaction_org
  FROM financial_transaction
  WHERE id = NEW.transaction_id;

  SELECT organization_id INTO account_org
  FROM ledger_account
  WHERE id = NEW.ledger_account_id;

  IF NEW.organization_id <> transaction_org OR NEW.organization_id <> account_org THEN
    RAISE EXCEPTION 'posting organization mismatch';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER posting_organization_consistency
BEFORE INSERT OR UPDATE ON posting
FOR EACH ROW EXECUTE FUNCTION app_assert_posting_organization_consistency();

CREATE OR REPLACE FUNCTION app_assert_financial_transaction_balanced()
RETURNS trigger AS $$
DECLARE
  checked_transaction_id uuid;
  posting_count integer;
  unbalanced_currency char(3);
BEGIN
  IF TG_TABLE_NAME = 'financial_transaction' THEN
    checked_transaction_id := COALESCE(NEW.id, OLD.id);
  ELSE
    checked_transaction_id := COALESCE(NEW.transaction_id, OLD.transaction_id);
  END IF;

  SELECT count(*) INTO posting_count
  FROM posting
  WHERE transaction_id = checked_transaction_id;

  IF posting_count < 2 THEN
    RAISE EXCEPTION 'financial transaction % must have at least two postings', checked_transaction_id;
  END IF;

  SELECT currency INTO unbalanced_currency
  FROM (
    SELECT
      currency,
      sum(CASE WHEN side = 'DEBIT' THEN amount ELSE -amount END) AS balance
    FROM posting
    WHERE transaction_id = checked_transaction_id
    GROUP BY currency
  ) balances
  WHERE balance <> 0
  LIMIT 1;

  IF unbalanced_currency IS NOT NULL THEN
    RAISE EXCEPTION 'financial transaction % is not balanced for currency %',
      checked_transaction_id,
      unbalanced_currency;
  END IF;

  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER financial_transaction_balanced_on_header
AFTER INSERT ON financial_transaction
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION app_assert_financial_transaction_balanced();

CREATE CONSTRAINT TRIGGER financial_transaction_balanced_on_posting
AFTER INSERT OR UPDATE OR DELETE ON posting
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION app_assert_financial_transaction_balanced();

ALTER TABLE ledger_account ENABLE ROW LEVEL SECURITY;
ALTER TABLE ledger_account FORCE ROW LEVEL SECURITY;
ALTER TABLE financial_transaction ENABLE ROW LEVEL SECURITY;
ALTER TABLE financial_transaction FORCE ROW LEVEL SECURITY;
ALTER TABLE posting ENABLE ROW LEVEL SECURITY;
ALTER TABLE posting FORCE ROW LEVEL SECURITY;

CREATE POLICY ledger_account_tenant_isolation ON ledger_account
  USING (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid)
  WITH CHECK (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid);

CREATE POLICY financial_transaction_tenant_isolation ON financial_transaction
  USING (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid)
  WITH CHECK (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid);

CREATE POLICY posting_tenant_isolation ON posting
  USING (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid)
  WITH CHECK (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid);
