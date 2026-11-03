BEGIN;
ALTER TABLE service_allocation_posting ENABLE ROW LEVEL SECURITY;
ALTER TABLE service_allocation_posting FORCE ROW LEVEL SECURITY;
DROP POLICY service_posting_tenant_isolation ON service_allocation_posting;
CREATE POLICY service_allocation_posting_tenant_isolation ON service_allocation_posting USING(organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid) WITH CHECK(organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid);
COMMIT;
