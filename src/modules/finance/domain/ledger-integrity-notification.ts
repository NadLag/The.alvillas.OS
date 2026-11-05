import { z } from "zod";
import type { AuthContext, Resource } from "@/platform/authz/authorize";
import { authorizeOrganizationSource } from "@/platform/authz/organization-authority";
import { financialRuleSourceChecks } from "@/platform/config/financial-rule-authority";
import { ledgerIntegrityPolicyKey, ledgerIntegrityRoutingSchema } from "./ledger-integrity";

export const ledgerIntegrityNoticeSchema = z.object({ runId: z.uuid(), policyId: z.uuid(), routingRuleId: z.uuid(), routing: ledgerIntegrityRoutingSchema }).strict();
export const ledgerIntegrityNoticeKey = (runId: string, recipientId: string) => `ledger-integrity:${runId}:${recipientId}`;
/** A failed full-ledger check cannot be disclosed through a partial source grant. */
export function canReadLedgerIntegrityFailure(auth: AuthContext, target: Resource, now = new Date()) {
  if (target.type !== "config_rule" || target.organizationId !== auth.organizationId || target.ledgerIntegrityFailed !== true || target.ruleKey !== ledgerIntegrityPolicyKey) return false;
  return authorizeOrganizationSource(auth, "view", { type: "config_rule", organizationId: auth.organizationId, dataClass: "financial" }, now) &&
    authorizeOrganizationSource(auth, "view", { type: "audit_log", organizationId: auth.organizationId }, now) &&
    financialRuleSourceChecks(auth.organizationId, ledgerIntegrityPolicyKey).every(check => authorizeOrganizationSource(auth, check.action, check.resource, now));
}
