BEGIN;

-- Retain migration195 byte-for-byte. Declare its existing protections explicitly
-- for the mandatory repository gate; every effective tenant predicate is unchanged.
ALTER TABLE signature_provider_scope ENABLE ROW LEVEL SECURITY;
ALTER TABLE signature_provider_scope FORCE ROW LEVEL SECURITY;
DROP POLICY signature_provider_scope_tenant_isolation ON signature_provider_scope;
CREATE POLICY signature_provider_scope_tenant_isolation ON signature_provider_scope
  USING (organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid)
  WITH CHECK (organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid);

ALTER TABLE signature_provider_intent ENABLE ROW LEVEL SECURITY;
ALTER TABLE signature_provider_intent FORCE ROW LEVEL SECURITY;
DROP POLICY signature_provider_intent_tenant_isolation ON signature_provider_intent;
CREATE POLICY signature_provider_intent_tenant_isolation ON signature_provider_intent
  USING (organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid)
  WITH CHECK (organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid);

ALTER TABLE signature_provider_attempt ENABLE ROW LEVEL SECURITY;
ALTER TABLE signature_provider_attempt FORCE ROW LEVEL SECURITY;
DROP POLICY signature_provider_attempt_tenant_isolation ON signature_provider_attempt;
CREATE POLICY signature_provider_attempt_tenant_isolation ON signature_provider_attempt
  USING (organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid)
  WITH CHECK (organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid);

ALTER TABLE signature_provider_evidence ENABLE ROW LEVEL SECURITY;
ALTER TABLE signature_provider_evidence FORCE ROW LEVEL SECURITY;
DROP POLICY signature_provider_evidence_tenant_isolation ON signature_provider_evidence;
CREATE POLICY signature_provider_evidence_tenant_isolation ON signature_provider_evidence
  USING (organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid)
  WITH CHECK (organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid);

COMMIT;
