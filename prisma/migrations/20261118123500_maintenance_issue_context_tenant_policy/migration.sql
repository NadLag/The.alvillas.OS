BEGIN;
-- Retain the applied context migration and its original policy bytes. Install
-- the repository's required policy name with exactly the same tenant predicate.
CREATE POLICY maintenance_issue_context_tenant_isolation ON maintenance_issue_context
 USING(organization_id=current_setting('app.current_organization_id',true)::uuid)
 WITH CHECK(organization_id=current_setting('app.current_organization_id',true)::uuid);
DROP POLICY maintenance_issue_context_tenant ON maintenance_issue_context;
COMMIT;
