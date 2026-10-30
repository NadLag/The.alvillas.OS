BEGIN;

DROP POLICY employee_compensation_submission_tenant ON employee_compensation_submission;
CREATE POLICY employee_compensation_submission_tenant_isolation ON employee_compensation_submission
 USING(organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid)
 WITH CHECK(organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid);
DROP POLICY employee_compensation_claim_tenant ON employee_compensation_claim;
CREATE POLICY employee_compensation_claim_tenant_isolation ON employee_compensation_claim
 USING(organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid)
 WITH CHECK(organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid);
DROP POLICY employee_compensation_cost_tenant ON employee_compensation_cost;
CREATE POLICY employee_compensation_cost_tenant_isolation ON employee_compensation_cost
 USING(organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid)
 WITH CHECK(organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid);
DROP POLICY employee_compensation_withdrawal_tenant ON employee_compensation_withdrawal;
CREATE POLICY employee_compensation_withdrawal_tenant_isolation ON employee_compensation_withdrawal
 USING(organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid)
 WITH CHECK(organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid);
DROP POLICY employee_compensation_submission_request_tenant ON employee_compensation_submission_request;
CREATE POLICY employee_compensation_submission_request_tenant_isolation ON employee_compensation_submission_request
 USING(organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid)
 WITH CHECK(organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid);
DROP POLICY employee_compensation_submission_outcome_tenant ON employee_compensation_submission_outcome;
CREATE POLICY employee_compensation_submission_outcome_tenant_isolation ON employee_compensation_submission_outcome
 USING(organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid)
 WITH CHECK(organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid);

COMMIT;
