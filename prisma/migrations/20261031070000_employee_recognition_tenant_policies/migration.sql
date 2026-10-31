BEGIN;
-- Keep the existing deny-by-default policies explicit for the static tenant-safety gate.
ALTER TABLE employee_compensation_recognition ENABLE ROW LEVEL SECURITY;
ALTER TABLE employee_compensation_recognition FORCE ROW LEVEL SECURITY;
DROP POLICY employee_compensation_recognition_tenant ON employee_compensation_recognition;
CREATE POLICY employee_compensation_recognition_tenant_isolation ON employee_compensation_recognition
 USING(organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid)
 WITH CHECK(organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid);
ALTER TABLE employee_compensation_recognition_line ENABLE ROW LEVEL SECURITY;
ALTER TABLE employee_compensation_recognition_line FORCE ROW LEVEL SECURITY;
DROP POLICY employee_compensation_recognition_line_tenant ON employee_compensation_recognition_line;
CREATE POLICY employee_compensation_recognition_line_tenant_isolation ON employee_compensation_recognition_line
 USING(organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid)
 WITH CHECK(organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid);
ALTER TABLE employee_compensation_recognition_request ENABLE ROW LEVEL SECURITY;
ALTER TABLE employee_compensation_recognition_request FORCE ROW LEVEL SECURITY;
DROP POLICY employee_compensation_recognition_request_tenant ON employee_compensation_recognition_request;
CREATE POLICY employee_compensation_recognition_request_tenant_isolation ON employee_compensation_recognition_request
 USING(organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid)
 WITH CHECK(organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid);
ALTER TABLE employee_compensation_recognition_outcome ENABLE ROW LEVEL SECURITY;
ALTER TABLE employee_compensation_recognition_outcome FORCE ROW LEVEL SECURITY;
DROP POLICY employee_compensation_recognition_outcome_tenant ON employee_compensation_recognition_outcome;
CREATE POLICY employee_compensation_recognition_outcome_tenant_isolation ON employee_compensation_recognition_outcome
 USING(organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid)
 WITH CHECK(organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid);
COMMIT;
