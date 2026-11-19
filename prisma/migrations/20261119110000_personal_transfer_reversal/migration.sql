BEGIN;
ALTER TABLE personal_transfer_resolution
  ADD COLUMN reverses_transfer_id uuid,
  ADD CONSTRAINT personal_transfer_resolution_reversed_fk
    FOREIGN KEY (organization_id, household_id, reverses_transfer_id)
    REFERENCES personal_transfer_resolution(organization_id, household_id, transfer_id)
    ON DELETE RESTRICT ON UPDATE NO ACTION,
  ADD CONSTRAINT personal_transfer_resolution_reversed_unique
    UNIQUE (organization_id, household_id, reverses_transfer_id),
  ADD CONSTRAINT personal_transfer_resolution_reversed_check
    CHECK (reverses_transfer_id IS NULL OR (kind = 'CONFIRMED' AND reverses_transfer_id <> transfer_id));
COMMIT;
