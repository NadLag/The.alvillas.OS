BEGIN;
CREATE POLICY employee_compensation_percentage_witness_tenant_isolation ON employee_compensation_percentage_witness
 USING(organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid)
 WITH CHECK(organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid);
DROP POLICY employee_percentage_tenant_isolation ON employee_compensation_percentage_witness;
COMMIT;
