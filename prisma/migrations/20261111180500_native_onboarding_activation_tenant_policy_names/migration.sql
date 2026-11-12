BEGIN;

-- Keep the admitted tenant predicates and forced RLS; use the repository's canonical policy names.
CREATE POLICY property_onboarding_activation_request_tenant_isolation ON property_onboarding_activation_request
 USING(organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid)
 WITH CHECK(organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid);
DROP POLICY onboarding_activation_request_tenant ON property_onboarding_activation_request;
CREATE POLICY property_onboarding_activation_event_tenant_isolation ON property_onboarding_activation_event
 USING(organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid)
 WITH CHECK(organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid);
DROP POLICY onboarding_activation_event_tenant ON property_onboarding_activation_event;

COMMIT;
