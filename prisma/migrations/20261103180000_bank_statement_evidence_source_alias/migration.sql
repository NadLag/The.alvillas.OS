BEGIN;

-- OLD is a PostgreSQL trigger record. Keep the original applied migration intact.
CREATE OR REPLACE FUNCTION app_bank_statement_evidence_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM bank_statement_import i JOIN bank_statement_admission a ON a.organization_id=i.organization_id AND a.id=i.admission_id
  JOIN bank_statement_line l ON l.organization_id=i.organization_id AND l.id=NEW.line_id
  WHERE i.organization_id=NEW.organization_id AND i.id=NEW.import_id AND l.bank_identity_hash=a.bank_identity_hash AND l.ledger_account_id=a.ledger_account_id
   AND NEW.source_order<=i.row_count AND NOT EXISTS(SELECT 1 FROM bank_statement_evidence retained_evidence WHERE retained_evidence.organization_id=i.organization_id AND retained_evidence.import_id=NEW.import_id AND retained_evidence.line_id=NEW.line_id AND retained_evidence.id<>NEW.id))
 THEN RAISE EXCEPTION 'bank statement evidence must retain its actual original source account and line'; END IF;
 RETURN NULL;
END $$;

COMMIT;
