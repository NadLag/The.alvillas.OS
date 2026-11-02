BEGIN;
-- Match the mandatory tenant-policy naming convention; preserve the exact enforced predicate.
DROP POLICY recurring_payout_draft_tenant_isolation ON recurring_payout_draft_occurrence;
CREATE POLICY recurring_payout_draft_occurrence_tenant_isolation ON recurring_payout_draft_occurrence
 USING(organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid)
 WITH CHECK(organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid);
COMMIT;
