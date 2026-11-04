BEGIN;

ALTER TABLE bank_statement_line ADD CONSTRAINT bank_statement_line_currency_fkey FOREIGN KEY (currency) REFERENCES currency(code) ON DELETE RESTRICT ON UPDATE NO ACTION;
CREATE INDEX bank_statement_admission_history_idx ON bank_statement_admission(organization_id,ledger_account_id,created_at DESC,id DESC);
CREATE INDEX bank_statement_line_original_import_idx ON bank_statement_line(organization_id,original_import_id);

COMMIT;
