-- Preserve migration244 and every native row; replace only its policy name atomically.
BEGIN;
CREATE POLICY guest_hub_link_revocation_tenant_isolation ON guest_hub_link_revocation
 USING(organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid)
 WITH CHECK(organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid);
DO $$
DECLARE previous pg_policy%ROWTYPE; canonical pg_policy%ROWTYPE; protected_table pg_class%ROWTYPE;
BEGIN
 SELECT * INTO STRICT previous FROM pg_policy WHERE polrelid='public.guest_hub_link_revocation'::regclass AND polname='guest_hub_revocation_tenant_isolation';
 SELECT * INTO STRICT canonical FROM pg_policy WHERE polrelid='public.guest_hub_link_revocation'::regclass AND polname='guest_hub_link_revocation_tenant_isolation';
 SELECT * INTO STRICT protected_table FROM pg_class WHERE oid=canonical.polrelid;
 IF NOT protected_table.relrowsecurity OR NOT protected_table.relforcerowsecurity
  OR previous.polcmd IS DISTINCT FROM canonical.polcmd OR previous.polroles IS DISTINCT FROM canonical.polroles
  OR previous.polpermissive IS DISTINCT FROM canonical.polpermissive
  OR pg_get_expr(previous.polqual,previous.polrelid) IS DISTINCT FROM pg_get_expr(canonical.polqual,canonical.polrelid)
  OR pg_get_expr(previous.polwithcheck,previous.polrelid) IS DISTINCT FROM pg_get_expr(canonical.polwithcheck,canonical.polrelid)
 THEN RAISE EXCEPTION 'guest_hub_canonical_policy_must_preserve_exact_forced_tenant_isolation'; END IF;
END $$;
DROP POLICY guest_hub_revocation_tenant_isolation ON guest_hub_link_revocation;
COMMIT;
