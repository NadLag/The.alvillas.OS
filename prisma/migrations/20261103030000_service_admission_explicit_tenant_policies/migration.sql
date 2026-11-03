BEGIN;
-- Preserve the original tenant predicates with explicit declarations for static verification.
ALTER TABLE service_financial_source ENABLE ROW LEVEL SECURITY;
ALTER TABLE service_financial_source FORCE ROW LEVEL SECURITY;
DROP POLICY service_financial_source_tenant_isolation ON service_financial_source;
CREATE POLICY service_financial_source_tenant_isolation ON service_financial_source USING(organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid) WITH CHECK(organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid);

ALTER TABLE service_allocation_admission ENABLE ROW LEVEL SECURITY;
ALTER TABLE service_allocation_admission FORCE ROW LEVEL SECURITY;
DROP POLICY service_allocation_admission_tenant_isolation ON service_allocation_admission;
CREATE POLICY service_allocation_admission_tenant_isolation ON service_allocation_admission USING(organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid) WITH CHECK(organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid);

ALTER TABLE service_allocation_provider_binding ENABLE ROW LEVEL SECURITY;
ALTER TABLE service_allocation_provider_binding FORCE ROW LEVEL SECURITY;
DROP POLICY service_allocation_provider_binding_tenant_isolation ON service_allocation_provider_binding;
CREATE POLICY service_allocation_provider_binding_tenant_isolation ON service_allocation_provider_binding USING(organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid) WITH CHECK(organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid);

ALTER TABLE service_allocation_provider_part ENABLE ROW LEVEL SECURITY;
ALTER TABLE service_allocation_provider_part FORCE ROW LEVEL SECURITY;
DROP POLICY service_allocation_provider_part_tenant_isolation ON service_allocation_provider_part;
CREATE POLICY service_allocation_provider_part_tenant_isolation ON service_allocation_provider_part USING(organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid) WITH CHECK(organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid);
COMMIT;
