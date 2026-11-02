BEGIN;
ALTER TABLE receivable_assignment ENABLE ROW LEVEL SECURITY;
ALTER TABLE receivable_assignment FORCE ROW LEVEL SECURITY;
DROP POLICY receivable_assignment_tenant_isolation ON receivable_assignment;
CREATE POLICY receivable_assignment_tenant_isolation ON receivable_assignment
  USING (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid)
  WITH CHECK (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid);

ALTER TABLE receivable_assignment_release ENABLE ROW LEVEL SECURITY;
ALTER TABLE receivable_assignment_release FORCE ROW LEVEL SECURITY;
DROP POLICY receivable_assignment_release_tenant_isolation ON receivable_assignment_release;
CREATE POLICY receivable_assignment_release_tenant_isolation ON receivable_assignment_release
  USING (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid)
  WITH CHECK (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid);
COMMIT;
