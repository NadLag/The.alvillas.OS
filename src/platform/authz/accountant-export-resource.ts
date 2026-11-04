import type { CurrentAuthorityCheck } from "./current-authority";
import type { AuthContext } from "./authorize";
import { authorizeOrganizationSource } from "./organization-authority";
import { propertyFinancePartySources } from "./property-finance-resource";
import { financialRuleSourceChecks } from "@/platform/config/financial-rule-authority";
import { accountantExportPolicyKey } from "@/modules/finance/domain/accountant-export-policy";

/** Complete reports cannot aggregate sources whose financial, party or property identity is independently forbidden. */
export function accountantExportAuthorityChecks(organizationId: string, action: "view" | "export" = "export"): CurrentAuthorityCheck[] {
  const actions = action === "export" ? ["view", "export"] as const : ["view"] as const;
  return [...financialRuleSourceChecks(organizationId, accountantExportPolicyKey, action),
    ...propertyFinancePartySources.flatMap(type => actions.map(action => ({ action, resource: { type, organizationId, dataClass: "personal" as const }, organizationOnly: true }))),
    ...actions.map(action => ({ action, resource: { type: "property", organizationId, dataClass: "operational" as const }, organizationOnly: true })),
    { action: "view", resource: { type: "config_rule", organizationId, dataClass: "financial" }, organizationOnly: true }];
}
export function canViewAccountantExport(auth: AuthContext, action: "view" | "export", now: Date): boolean {
  return accountantExportAuthorityChecks(auth.organizationId, action).every(check => authorizeOrganizationSource(auth, check.action, check.resource, now));
}
