BEGIN;

-- Keep the applied original policies and add the standard named restrictive
-- tenant guards. Together with the existing permissive tenant policies these
-- retain exactly the same access and cannot be broadened by another policy.
CREATE POLICY accounting_period_tenant_isolation ON accounting_period AS RESTRICTIVE
 USING (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid)
 WITH CHECK (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid);

CREATE POLICY accounting_period_event_tenant_isolation ON accounting_period_event AS RESTRICTIVE
 USING (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid)
 WITH CHECK (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid);

COMMIT;
