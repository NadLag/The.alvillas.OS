BEGIN;

-- Validate the first journal link independently of journal/draft insertion order.
-- Existing links and later exact voids retain their immutable original dates.
CREATE FUNCTION app_expense_correction_link_date_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE journal financial_transaction%ROWTYPE; source_timezone text; point timestamptz;
BEGIN
 IF NEW.corrects_expense_id IS NULL OR NEW.transaction_id IS NULL OR OLD.transaction_id IS NOT NULL THEN RETURN NEW; END IF;
 SELECT * INTO journal FROM financial_transaction WHERE organization_id=NEW.organization_id AND id=NEW.transaction_id;
 SELECT snapshot->>'timezone' INTO source_timezone FROM expense_submission
  WHERE organization_id=NEW.organization_id AND expense_id=NEW.corrects_expense_id;
 point:=clock_timestamp();
 IF journal.id IS NULL OR source_timezone IS NULL
  OR journal.occurred_at<date_trunc('milliseconds',transaction_timestamp()) OR journal.occurred_at>point
  OR date_trunc('month',journal.occurred_at AT TIME ZONE source_timezone) IS DISTINCT FROM date_trunc('month',point AT TIME ZONE source_timezone)
 THEN RAISE EXCEPTION 'expense correction must create a new journal in the current open period'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER expense_correction_link_date_guard BEFORE UPDATE ON expense
 FOR EACH ROW EXECUTE FUNCTION app_expense_correction_link_date_guard();

COMMIT;
