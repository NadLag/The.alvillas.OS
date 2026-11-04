import type { Action, Resource } from "./authorize";
import type { CurrentAuthorityCheck } from "./current-authority";
import type { NativeFinancialResource } from "@/platform/ledger/financial-transaction-resource-repository";

/** Every file version inherits the original journal's current disclosure restrictions. */
export function financialAttachmentAuthorityChecks(source: NativeFinancialResource, action: Action, rootId?: string): CurrentAuthorityCheck[] | null {
  if (source.type !== "financial_transaction" || !source.id || source.organizationId.length === 0) return null;
  const checks: CurrentAuthorityCheck[] = [{ action: "view", resource: source }];
  if (action === "export") checks.push({ action: "export", resource: source });
  if (source.salarySources) {
    if (!source.salarySources.length || !source.financialSources?.length || source.compensationRoot?.type !== "employee_payable") return null;
    checks.push({ action: "view", resource: source.compensationRoot }, ...source.salarySources.map(resource => ({ action: "view" as const, resource })));
  }
  checks.push(...(source.financialSources ?? []).map(resource => ({ action: "view" as const, resource })),
    ...(source.companyFinancialSources ?? []).map(resource => ({ action: "view" as const, resource, organizationOnly: true })),
    ...(source.walletSources ?? []).map(resource => ({ action: "view" as const, resource })));
  if (checks.some(check => check.resource.organizationId !== source.organizationId)) return null;
  const resource: Resource = { ...source, type: "financial_attachment", id: rootId, financialRecordId: source.id, dataClass: "financial" };
  return [...checks, ...(action === "view" ? [] : [{ action: "view" as const, resource }]), { action, resource }];
}
