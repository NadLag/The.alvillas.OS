BEGIN;

-- Preserve the already-applied policy semantics while making every tenant fence
-- independently visible to the repository's mandatory static source check.
DO $$
DECLARE before_policies jsonb; after_policies jsonb;
BEGIN
  SELECT jsonb_agg(jsonb_build_object('table',c.relname,'enabled',c.relrowsecurity,'forced',c.relforcerowsecurity,
    'name',p.polname,'command',p.polcmd,'permissive',p.polpermissive,'roles',p.polroles,
    'using',pg_get_expr(p.polqual,p.polrelid),'check',pg_get_expr(p.polwithcheck,p.polrelid)) ORDER BY c.relname)
  INTO before_policies FROM pg_class c JOIN pg_policy p ON p.polrelid=c.oid
  WHERE c.relnamespace='public'::regnamespace
    AND c.relname IN('external_payment_refund_intent','external_payment_refund_attempt','external_payment_refund_identity','external_payment_refund_evidence')
    AND p.polname=c.relname||'_tenant_isolation';
  IF jsonb_array_length(before_policies) IS DISTINCT FROM 4 OR EXISTS(
    SELECT 1 FROM jsonb_array_elements(before_policies) p WHERE p->>'enabled'<>'true' OR p->>'forced'<>'true'
  ) THEN RAISE EXCEPTION 'original forced refund tenant policies required'; END IF;

  ALTER TABLE external_payment_refund_intent ENABLE ROW LEVEL SECURITY;
  ALTER TABLE external_payment_refund_intent FORCE ROW LEVEL SECURITY;
  DROP POLICY external_payment_refund_intent_tenant_isolation ON external_payment_refund_intent;
  CREATE POLICY external_payment_refund_intent_tenant_isolation ON external_payment_refund_intent
    USING(organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid)
    WITH CHECK(organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid);

  ALTER TABLE external_payment_refund_attempt ENABLE ROW LEVEL SECURITY;
  ALTER TABLE external_payment_refund_attempt FORCE ROW LEVEL SECURITY;
  DROP POLICY external_payment_refund_attempt_tenant_isolation ON external_payment_refund_attempt;
  CREATE POLICY external_payment_refund_attempt_tenant_isolation ON external_payment_refund_attempt
    USING(organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid)
    WITH CHECK(organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid);

  ALTER TABLE external_payment_refund_identity ENABLE ROW LEVEL SECURITY;
  ALTER TABLE external_payment_refund_identity FORCE ROW LEVEL SECURITY;
  DROP POLICY external_payment_refund_identity_tenant_isolation ON external_payment_refund_identity;
  CREATE POLICY external_payment_refund_identity_tenant_isolation ON external_payment_refund_identity
    USING(organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid)
    WITH CHECK(organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid);

  ALTER TABLE external_payment_refund_evidence ENABLE ROW LEVEL SECURITY;
  ALTER TABLE external_payment_refund_evidence FORCE ROW LEVEL SECURITY;
  DROP POLICY external_payment_refund_evidence_tenant_isolation ON external_payment_refund_evidence;
  CREATE POLICY external_payment_refund_evidence_tenant_isolation ON external_payment_refund_evidence
    USING(organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid)
    WITH CHECK(organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid);

  SELECT jsonb_agg(jsonb_build_object('table',c.relname,'enabled',c.relrowsecurity,'forced',c.relforcerowsecurity,
    'name',p.polname,'command',p.polcmd,'permissive',p.polpermissive,'roles',p.polroles,
    'using',pg_get_expr(p.polqual,p.polrelid),'check',pg_get_expr(p.polwithcheck,p.polrelid)) ORDER BY c.relname)
  INTO after_policies FROM pg_class c JOIN pg_policy p ON p.polrelid=c.oid
  WHERE c.relnamespace='public'::regnamespace
    AND c.relname IN('external_payment_refund_intent','external_payment_refund_attempt','external_payment_refund_identity','external_payment_refund_evidence')
    AND p.polname=c.relname||'_tenant_isolation';
  IF before_policies IS DISTINCT FROM after_policies THEN RAISE EXCEPTION 'preserve every original refund tenant policy definition'; END IF;
END $$;

COMMIT;
