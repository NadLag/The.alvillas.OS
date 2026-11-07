-- Forward-only: the frozen original already forces RLS and creates these exact
-- policies through a loop. State the same definitions explicitly so the static
-- organization gate can verify them without weakening its assertions.
ALTER TABLE signature_signed_archive ENABLE ROW LEVEL SECURITY;
ALTER TABLE signature_signed_archive FORCE ROW LEVEL SECURITY;
DROP POLICY signature_signed_archive_tenant_isolation ON signature_signed_archive;
CREATE POLICY signature_signed_archive_tenant_isolation ON signature_signed_archive
  USING (organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid)
  WITH CHECK (organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid);

ALTER TABLE signature_signed_artifact ENABLE ROW LEVEL SECURITY;
ALTER TABLE signature_signed_artifact FORCE ROW LEVEL SECURITY;
DROP POLICY signature_signed_artifact_tenant_isolation ON signature_signed_artifact;
CREATE POLICY signature_signed_artifact_tenant_isolation ON signature_signed_artifact
  USING (organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid)
  WITH CHECK (organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid);
