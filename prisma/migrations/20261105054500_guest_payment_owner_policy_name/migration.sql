BEGIN;

-- Keep the applied provenance migration immutable. Install the canonical policy
-- name with the same predicate before removing its earlier equivalent.
CREATE POLICY guest_payment_receipt_owner_tenant_isolation ON guest_payment_receipt_owner
USING (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid)
WITH CHECK (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid);

DROP POLICY guest_payment_owner_tenant_isolation ON guest_payment_receipt_owner;

COMMIT;
