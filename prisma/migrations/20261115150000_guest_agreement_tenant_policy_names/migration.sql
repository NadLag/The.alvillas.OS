BEGIN;
-- Match the standard tenant-policy contract with identical forced-RLS predicates.
CREATE POLICY guest_hub_agreement_release_tenant_isolation ON guest_hub_agreement_release
 USING(organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid)
 WITH CHECK(organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid);
DROP POLICY guest_agreement_release_tenant ON guest_hub_agreement_release;
CREATE POLICY guest_hub_agreement_request_tenant_isolation ON guest_hub_agreement_request
 USING(organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid)
 WITH CHECK(organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid);
DROP POLICY guest_agreement_request_tenant ON guest_hub_agreement_request;
CREATE POLICY guest_hub_agreement_document_origin_tenant_isolation ON guest_hub_agreement_document_origin
 USING(organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid)
 WITH CHECK(organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid);
DROP POLICY guest_agreement_origin_tenant ON guest_hub_agreement_document_origin;
COMMIT;
