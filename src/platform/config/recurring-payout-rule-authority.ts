import type { AuthContext } from "@/platform/authz/authorize";
import { authorizeOrganizationSource } from "@/platform/authz/organization-authority";
import { recheckAccountAuthorization, type CurrentAuthorityCheck } from "@/platform/authz/current-authority";
import type { TenantTransaction } from "@/platform/db/tenant";
import { recurringPayoutDraftPolicyKey } from "@/modules/finance/domain/recurring-payout-draft";
import { FinanceRepository } from "@/modules/finance/infrastructure/finance-repository";
export { recurringPayoutDraftPolicyKey };

export function recurringPayoutDraftRuleAccess(auth: AuthContext, action: "view" | "export" = "view", now = new Date()) {
  return ["financial_transaction", "owner_statement"].every(type => {
    const resource = { type, organizationId: auth.organizationId, dataClass: "financial" as const };
    return authorizeOrganizationSource(auth, "view", resource, now) && (action === "view" || authorizeOrganizationSource(auth, "export", resource, now));
  });
}
export async function recheckRecurringPayoutDraftRuleAccess(ctx: { organizationId: string; actorId: string; authContext: AuthContext }, tx: TenantTransaction, key: string, checks: readonly CurrentAuthorityCheck[], denied: Error) {
  if (key !== recurringPayoutDraftPolicyKey) return;
  const now = await new FinanceRepository(tx, ctx.organizationId).clock();
  await recheckAccountAuthorization(ctx, tx, now, [...checks, ...["financial_transaction", "owner_statement"].map(type => ({ action: "view" as const,
    resource: { type, organizationId: ctx.organizationId, dataClass: "financial" as const }, organizationOnly: true }))], denied);
}
export function containsRecurringPayoutDraftRule(value: unknown): boolean {
  return Boolean(value && typeof value === "object" && Object.entries(value).some(([key, item]) => key === recurringPayoutDraftPolicyKey ||
    key.startsWith("/rules/" + recurringPayoutDraftPolicyKey + "/") || key === "key" && item === recurringPayoutDraftPolicyKey ||
    key === "source" && item === "CURRENT_DERIVED_OWNER_PAYABLE" || containsRecurringPayoutDraftRule(item)));
}
