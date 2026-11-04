BEGIN;

-- A replacement is a new retained fact for the same actual movement. An active
-- association of its earlier version must be released before a fresh admission.
CREATE FUNCTION app_bank_reconciliation_family_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
 IF NEW.line_id IS NULL THEN RETURN NULL; END IF;
 IF EXISTS(WITH RECURSIVE ancestors AS (
  SELECT id,ledger_account_id,bank_identity_hash,external_id,corrects_external_id FROM bank_statement_line WHERE organization_id=NEW.organization_id AND id=NEW.line_id
  UNION
  SELECT parent.id,parent.ledger_account_id,parent.bank_identity_hash,parent.external_id,parent.corrects_external_id
  FROM bank_statement_line parent JOIN ancestors child ON parent.organization_id=NEW.organization_id AND parent.ledger_account_id=child.ledger_account_id
   AND parent.bank_identity_hash=child.bank_identity_hash AND parent.external_id=child.corrects_external_id
 ) SELECT 1 FROM ancestors original JOIN bank_reconciliation_allocation allocation ON allocation.organization_id=NEW.organization_id AND allocation.line_id=original.id
  JOIN bank_reconciliation_entry entry ON entry.organization_id=allocation.organization_id AND entry.id=allocation.entry_id
  WHERE original.id<>NEW.line_id AND entry.action='MATCH' AND NOT EXISTS(
   SELECT 1 FROM bank_reconciliation_entry released WHERE released.organization_id=entry.organization_id AND released.previous_entry_id=entry.id))
 THEN RAISE EXCEPTION 'bank correction requires release of every active original source association'; END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER bank_reconciliation_allocation_family_guard AFTER INSERT ON bank_reconciliation_allocation DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app_bank_reconciliation_family_guard();

COMMIT;
