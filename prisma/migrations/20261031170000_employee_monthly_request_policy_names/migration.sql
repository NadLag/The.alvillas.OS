BEGIN;
DROP POLICY employee_monthly_run_request_tenant ON employee_monthly_run_request;
CREATE POLICY employee_monthly_run_request_tenant_isolation ON employee_monthly_run_request
 USING(organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid)
 WITH CHECK(organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid);
DROP POLICY employee_monthly_run_outcome_tenant ON employee_monthly_run_outcome;
CREATE POLICY employee_monthly_run_outcome_tenant_isolation ON employee_monthly_run_outcome
 USING(organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid)
 WITH CHECK(organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid);

COMMIT;
