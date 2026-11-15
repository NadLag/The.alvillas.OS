BEGIN;
-- Preserve the original immutable migration; use the canonical tenant-policy name.
CREATE POLICY guest_hub_identity_document_delegation_tenant_isolation
ON guest_hub_identity_document_delegation
USING (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid)
WITH CHECK (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid);
DROP POLICY guest_identity_delegation_tenant_isolation ON guest_hub_identity_document_delegation;
COMMIT;
