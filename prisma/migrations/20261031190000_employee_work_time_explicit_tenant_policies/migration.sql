BEGIN;
ALTER TABLE employee_work_time_evidence ENABLE ROW LEVEL SECURITY;
ALTER TABLE employee_work_time_evidence FORCE ROW LEVEL SECURITY;
DROP POLICY employee_work_time_evidence_tenant_isolation ON employee_work_time_evidence;
CREATE POLICY employee_work_time_evidence_tenant_isolation ON employee_work_time_evidence
 USING(organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid)
 WITH CHECK(organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid);

ALTER TABLE employee_work_time_interval ENABLE ROW LEVEL SECURITY;
ALTER TABLE employee_work_time_interval FORCE ROW LEVEL SECURITY;
DROP POLICY employee_work_time_interval_tenant_isolation ON employee_work_time_interval;
CREATE POLICY employee_work_time_interval_tenant_isolation ON employee_work_time_interval
 USING(organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid)
 WITH CHECK(organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid);

ALTER TABLE employee_work_time_decision ENABLE ROW LEVEL SECURITY;
ALTER TABLE employee_work_time_decision FORCE ROW LEVEL SECURITY;
DROP POLICY employee_work_time_decision_tenant_isolation ON employee_work_time_decision;
CREATE POLICY employee_work_time_decision_tenant_isolation ON employee_work_time_decision
 USING(organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid)
 WITH CHECK(organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid);

COMMIT;
