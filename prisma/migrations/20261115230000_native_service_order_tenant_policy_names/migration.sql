-- Replace only policy names, retaining the original tenant predicates atomically.
BEGIN;
CREATE POLICY service_order_tenant_isolation ON service_order
 USING(organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid)
 WITH CHECK(organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid);
DROP POLICY service_order_tenant ON service_order;
CREATE POLICY service_order_event_tenant_isolation ON service_order_event
 USING(organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid)
 WITH CHECK(organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid);
DROP POLICY service_order_event_tenant ON service_order_event;
COMMIT;
