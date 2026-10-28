BEGIN;

-- Keep the applied supplier-source migration immutable. Replace only the policy
-- name to follow the existing tenant-policy contract, with identical predicates.
DROP POLICY supplier_organization_isolation ON supplier;
CREATE POLICY supplier_tenant_isolation ON supplier
 USING (organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid)
 WITH CHECK (organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid);

COMMIT;
