BEGIN;
DROP POLICY employee_contract_witness_tenant_isolation ON employee_compensation_contract_witness;
CREATE POLICY employee_compensation_contract_witness_tenant_isolation ON employee_compensation_contract_witness
 USING(organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid)
 WITH CHECK(organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid);
COMMIT;
