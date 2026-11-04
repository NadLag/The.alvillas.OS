BEGIN;

LOCK TABLE bank_reconciliation_allocation IN ACCESS EXCLUSIVE MODE;

-- Existing allocation facts are append-only. Never silently infer and update
-- their currency: a populated environment needs an owner-reviewed enrichment.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM bank_reconciliation_allocation) THEN
    RAISE EXCEPTION 'F-FIN-40 legacy allocation currency enrichment requires owner review; retained financial history is unchanged';
  END IF;
END;
$$;

ALTER TABLE bank_reconciliation_allocation ADD COLUMN currency char(3) NOT NULL;

CREATE UNIQUE INDEX bank_reconciliation_entry_org_id_currency_unique
  ON bank_reconciliation_entry (organization_id, id, currency);

ALTER TABLE bank_reconciliation_allocation
  DROP CONSTRAINT bank_reconciliation_allocation_organization_id_entry_id_fkey;
ALTER TABLE bank_reconciliation_allocation
  ADD CONSTRAINT bank_reconciliation_allocation_entry_currency_fk
  FOREIGN KEY (organization_id, entry_id, currency)
  REFERENCES bank_reconciliation_entry (organization_id, id, currency)
  ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE bank_reconciliation_allocation
  ADD CONSTRAINT bank_reconciliation_allocation_currency_fk
  FOREIGN KEY (currency) REFERENCES currency (code)
  ON DELETE RESTRICT ON UPDATE NO ACTION;

COMMIT;
