BEGIN;

DROP POLICY financial_attachment_admission_tenant ON financial_attachment_admission;
CREATE POLICY financial_attachment_admission_tenant_isolation ON financial_attachment_admission
 USING (organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid)
 WITH CHECK (organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid);

DROP POLICY financial_attachment_tenant ON financial_attachment;
CREATE POLICY financial_attachment_tenant_isolation ON financial_attachment
 USING (organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid)
 WITH CHECK (organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid);

COMMIT;
