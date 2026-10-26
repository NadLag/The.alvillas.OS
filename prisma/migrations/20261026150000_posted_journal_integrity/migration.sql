BEGIN;

-- The constant default seals existing headers without updating financial rows.
ALTER TABLE financial_transaction ADD COLUMN sealed boolean NOT NULL DEFAULT true;

CREATE FUNCTION app_begin_financial_transaction_write()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.sealed := false;
  RETURN NEW;
END;
$$;

CREATE TRIGGER financial_transaction_begin_write
BEFORE INSERT ON financial_transaction
FOR EACH ROW EXECUTE FUNCTION app_begin_financial_transaction_write();

-- Only the deferred finalizer may change the technical seal on an uncommitted
-- header. Every financial field and every previously posted row stays immutable.
CREATE OR REPLACE FUNCTION app_prevent_ledger_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME = 'financial_transaction' AND TG_OP = 'UPDATE'
     AND pg_trigger_depth() > 1
     AND to_jsonb(OLD)->'sealed' = 'false'::jsonb
     AND to_jsonb(NEW)->'sealed' = 'true'::jsonb
     AND (to_jsonb(OLD) - 'sealed') IS NOT DISTINCT FROM (to_jsonb(NEW) - 'sealed') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'ledger rows are append-only';
END;
$$;

CREATE FUNCTION app_finish_financial_transaction_write()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE financial_transaction SET sealed = true
  WHERE organization_id = NEW.organization_id AND id = NEW.id AND NOT sealed;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'financial transaction could not be sealed in its tenant scope';
  END IF;
  RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER financial_transaction_finish_write
AFTER INSERT ON financial_transaction
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION app_finish_financial_transaction_write();

CREATE FUNCTION app_assert_posting_header_unsealed()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE header_sealed boolean;
BEGIN
  SELECT sealed INTO header_sealed FROM financial_transaction
  WHERE organization_id = NEW.organization_id AND id = NEW.transaction_id;
  IF header_sealed IS DISTINCT FROM false THEN
    RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'posting_header_unsealed',
      MESSAGE = 'posting lines must be created before their transaction is sealed';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER posting_header_unsealed
BEFORE INSERT ON posting
FOR EACH ROW EXECUTE FUNCTION app_assert_posting_header_unsealed();

COMMIT;
