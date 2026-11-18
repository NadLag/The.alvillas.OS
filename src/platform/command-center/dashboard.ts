import { assignmentCandidates, authorizeCollection, type AuthContext } from "@/platform/authz/authorize";
import { canViewCommandFinance } from "@/modules/finance/application/command-center-finance";
import { canViewCompleteCompanyLedger } from "@/modules/finance/domain/company-ledger";
import { exceptionSections } from "./exceptions";

export const dashboardProfiles = ["manager", "operations", "finance"] as const;
export type DashboardProfile = typeof dashboardProfiles[number];
const managerRoles = ["admin", "regional_manager", "property_manager", "operations_manager"] as const;
const operationRoles = ["admin", "regional_manager", "property_manager", "operations_manager", "co_host", "qa_inspector", "maintenance", "guest_experience"] as const;
const financeRoles = ["admin", "finance", "accountant", "revenue_manager"] as const;

export function dashboardAccess(context: AuthContext, now = new Date()) {
  const active = assignmentCandidates(context).filter(grant => grant.scope.organizationId === context.organizationId
    && (!grant.validFrom || grant.validFrom <= now) && (!grant.validTo || grant.validTo > now));
  const hasRole = (roles: readonly string[]) => active.some(grant => grant.roleKey && roles.includes(grant.roleKey));
  const operative = authorizeCollection(context, "view", "task");
  const stays = authorizeCollection(context, "view", "reservation");
  const financial = canViewCommandFinance(context, now);
  const ledger = canViewCompleteCompanyLedger(context, { type: "company_ledger", organizationId: context.organizationId, dataClass: "financial" }, now);
  const exceptions = exceptionSections(context).length > 0;
  const manager = hasRole(managerRoles), operations = hasRole(operationRoles), finance = hasRole(financeRoles);
  const custom = !manager && !operations && !finance;
  const profiles: DashboardProfile[] = [];
  if (manager && (operative || stays || financial || exceptions)) profiles.push("manager");
  if ((operative || stays) && (operations || custom)) profiles.push("operations");
  if ((ledger || financial) && (finance || custom)) profiles.push("finance");
  return { profiles, operative, stays, financial, ledger, exceptions };
}
