BEGIN;
DROP POLICY asset_lifecycle_tenant ON asset_lifecycle_event;
CREATE POLICY asset_lifecycle_event_tenant_isolation ON asset_lifecycle_event
  USING (organization_id=nullif(current_setting('app.current_organization_id',true),'')::uuid)
  WITH CHECK (organization_id=nullif(current_setting('app.current_organization_id',true),'')::uuid);
COMMIT;
