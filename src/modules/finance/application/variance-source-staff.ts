import { VarianceWorkflowSourceError } from "../domain/variance-workflow";
import { employeeReconciliationTotals } from "../domain/employee-reconciliation";
import { VarianceWorkflowRepository } from "../infrastructure/variance-workflow-repository";
import { prepareEmployeeCompensationSettlement, employeeSettlementPaymentResource } from "./employee-compensation-settlement";
import { employeeNativeReconciliationInput } from "./employee-compensation-reconciliation";
import type { recheckFinanceAuthorization } from "./finance-access";
import type { VarianceSourceAuthority } from "./variance-workflow-service";

export const authorizeStaffVarianceSource: VarianceSourceAuthority = async (ctx, reference, tx, access) => {
  if (reference.provider !== "STAFF") throw new VarianceWorkflowSourceError();
  const claim = await new VarianceWorkflowRepository(tx, ctx.organizationId).originalClaim(reference.id);
  if (!claim) throw new VarianceWorkflowSourceError();
  const source = await prepareEmployeeCompensationSettlement(ctx, claim.submissionId, claim.id, tx, "view");
  if (!source.existing) throw new VarianceWorkflowSourceError();
  type Check = Parameters<typeof recheckFinanceAuthorization>[3][number];
  const write = access !== "view" && access !== "history", extra: Check[] = write ? source.sourceActionChecks("reconcile") : [];
  if (access === "ASSIGN") extra.push(...source.sourceActionChecks("assign"));
  for (const journal of source.journals) {
    const saved = source.receipts.get(journal.reversesTransactionId ?? journal.id);
    if (!saved) continue;
    const resource = employeeSettlementPaymentResource(ctx, source, saved.input.amount, journal.occurredAt, journal.id, journal.createdBy ?? undefined);
    if (write) extra.push({ action: "reconcile", resource, organizationOnly: !resource.propertyId });
    if (access === "history") extra.push({ action: "view", resource: { ...resource, type: "audit_log" }, organizationOnly: !resource.propertyId });
  }
  if (access === "history") for (const check of source.sourceActionChecks("reconcile")) extra.push({ action: "view", resource: { ...check.resource, type: "audit_log" } });
  const recheck = async () => { await source.recheckSettlement(await source.finance.clock(), extra); };
  await recheck();
  const currency = source.retained.amount.currency, plan = employeeReconciliationTotals(await employeeNativeReconciliationInput(ctx, source, claim.id));
  return { facts: { kind: "MONEY", unit: plan.unit, currency, expected: plan.expected, actual: plan.actual, variance: plan.variance }, recheck };
};
