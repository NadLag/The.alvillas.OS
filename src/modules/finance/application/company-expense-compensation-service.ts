import { randomUUID } from "node:crypto";
import { prisma } from "@/platform/db/client";
import { withTenant, type TenantTransactionRunner } from "@/platform/db/tenant";
import { writeAuditEvent } from "@/platform/audit/audit-writer";
import { Money } from "@/platform/money/money";
import { companyExpenseCompensationCommandSchema, companyExpenseCompensationHistorySchema } from "../domain/company-expense-compensation";
import { CompanyExpenseAccessError, CompanyExpenseChangedError } from "../domain/company-expense";
import { CompanyExpenseRepository } from "../infrastructure/company-expense-repository";
import { CompanyExpenseCompensationRepository } from "../infrastructure/company-expense-compensation-repository";
import { FinanceRepository } from "../infrastructure/finance-repository";
import { prepareEmployeeCompensationSettlement } from "./employee-compensation-settlement";
import { getEmployeeCompensationPaymentWorkspace } from "./employee-compensation-payment-workspace";
import { recheckCompanyExpenseAccess } from "./company-expense-service";
import { recheckFinanceAuthorization, type FinanceActorContext } from "./finance-access";

type Deps = { db?: TenantTransactionRunner; requestId?: string };
async function salaryAccess(ctx: FinanceActorContext, repository: CompanyExpenseCompensationRepository) {
  await recheckFinanceAuthorization(ctx, repository.tx, await new FinanceRepository(repository.tx, ctx.organizationId).clock(), [
    { action: "view", resource: { type: "staff_compensation", organizationId: ctx.organizationId, dataClass: "financial" }, organizationOnly: true }
  ], new CompanyExpenseAccessError());
}
function actualCost(source: Awaited<ReturnType<typeof prepareEmployeeCompensationSettlement>>, id: string) {
  const cost = source.row.costs.find(row => row.id === id), retained = source.retained.costs.find(row => row.id === id);
  const recognition = source.existing?.lines.find(row => row.costId === id);
  if (!cost || !retained || !recognition || cost.propertyId || cost.reservationId) throw new CompanyExpenseAccessError();
  const journal = source.journals.find(row => row.id === recognition.transactionId);
  if (!journal) throw new CompanyExpenseAccessError();
  return { cost, recognition, journal };
}

/** Associates the actual recognized company cost. Salary claims and payment journals stay canonical. */
export async function changeCompanyExpenseCompensationSource(ctx: FinanceActorContext, raw: unknown, deps: Deps = {}) {
  const input = companyExpenseCompensationCommandSchema.parse(raw);
  return withTenant(deps.db ?? prisma, ctx.organizationId, async tx => {
    const repository = new CompanyExpenseCompensationRepository(tx, ctx.organizationId), plans = new CompanyExpenseRepository(tx, ctx.organizationId);
    const hint = await repository.cost(input.employeeCostId);if (!hint || hint.propertyId || hint.reservationId) throw new CompanyExpenseAccessError();
    await plans.lockPlanRead(input.companyExpenseId);
    const plan = await plans.latest(input.companyExpenseId);if (!plan) throw new CompanyExpenseAccessError();
    await recheckCompanyExpenseAccess(ctx, tx, plan, "edit");await salaryAccess(ctx, repository);
    const source = await prepareEmployeeCompensationSettlement(ctx, hint.submissionId, hint.claimId, tx, "view");
    const { cost, recognition, journal } = actualCost(source, hint.id);
    await repository.lockSource(cost.id);
    const state = input.operation === "ATTACH" ? "ATTACHED" : "RELEASED", previous = await repository.current(cost.id);
    if (previous && previous.version === input.expectedSourceVersion + 1 && previous.state === state && previous.companyExpenseId === plan.companyExpenseId &&
      previous.planVersion === input.expectedPlanVersion && previous.createdBy === ctx.actorId && previous.reason === input.reason) {
      await source.recheckSettlement(await source.finance.clock());await recheckCompanyExpenseAccess(ctx, tx, plan, "edit");await salaryAccess(ctx, repository);
      return { id: previous.id, version: previous.version, idempotent: true };
    }
    if (plan.version !== input.expectedPlanVersion || (previous?.version ?? 0) !== input.expectedSourceVersion ||
      input.operation === "ATTACH" && (previous?.state === "ATTACHED" || plan.state !== "PLANNED" || plan.dataClass !== "STAFF_COMPENSATION" ||
        cost.currency !== plan.currency || cost.category !== plan.category || cost.costCenter !== plan.costCenter || journal.reversedByTransactions.length > 0) ||
      input.operation === "RELEASE" && (!previous || previous.state !== "ATTACHED" || previous.companyExpenseId !== plan.companyExpenseId)) throw new CompanyExpenseChangedError();
    const now = await source.finance.clock(), row = await repository.append({ employeeCostId: cost.id, companyExpenseId: plan.companyExpenseId, planVersion: plan.version,
      dataClass: "STAFF_COMPENSATION", version: (previous?.version ?? 0) + 1, state, reason: input.reason, createdBy: ctx.actorId, createdAt: now });
    await writeAuditEvent(tx, { organizationId: ctx.organizationId, actorId: ctx.actorId, action: state === "ATTACHED" ? "company_expense.compensation_attached" : "company_expense.compensation_released",
      resourceType: "company_expense", resourceId: plan.companyExpenseId, before: previous ? { linkId: previous.id, companyExpenseId: previous.companyExpenseId, version: previous.version, state: previous.state } : null,
      after: { linkId: row.id, employeeCostId: cost.id, submissionId: cost.submissionId, claimId: cost.claimId, runId: source.row.runId, transactionId: recognition.transactionId,
        version: row.version, planVersion: plan.version, state, dataClass: "STAFF_COMPENSATION", ...Money.of(cost.amount, cost.currency).toJSON() },
      reason: input.reason, requestId: deps.requestId ?? randomUUID(), occurredAt: now });
    await source.recheckSettlement(await source.finance.clock());await recheckCompanyExpenseAccess(ctx, tx, plan, "edit");await salaryAccess(ctx, repository);
    return { id: row.id, version: row.version, idempotent: false };
  });
}

/** Settlement amounts and payment history belong to the employee claim, without allocating payments to a cost line. */
export async function getCompanyExpenseCompensationSources(ctx: FinanceActorContext, raw: unknown, deps: Deps = {}) {
  const input = companyExpenseCompensationHistorySchema.parse(raw);
  return withTenant(deps.db ?? prisma, ctx.organizationId, async tx => {
    const repository = new CompanyExpenseCompensationRepository(tx, ctx.organizationId), plans = new CompanyExpenseRepository(tx, ctx.organizationId), finance = new FinanceRepository(tx, ctx.organizationId);
    await plans.lockPlanRead(input.companyExpenseId);
    const plan = await plans.latest(input.companyExpenseId);if (!plan) throw new CompanyExpenseAccessError();
    await recheckCompanyExpenseAccess(ctx, tx, plan, "view");await salaryAccess(ctx, repository);
    const history = await repository.history(input.companyExpenseId, input.before), rows = history.slice(0, 50);
    const current = new Map((await repository.currentMany(rows.map(row => row.employeeCostId))).map(row => [row.employeeCostId, row]));
    const claims = new Map(rows.map(row => { const cost = row.employeeCost;return [[cost.submission.runId, cost.submissionId, cost.claimId].join(":"), cost] as const; }));
    const sources = new Map<string, Awaited<ReturnType<typeof prepareEmployeeCompensationSettlement>>>();
    const settlements = new Map<string, Awaited<ReturnType<typeof getEmployeeCompensationPaymentWorkspace>>>();
    for (const key of [...claims.keys()].sort()) {
      const cost = claims.get(key)!;
      sources.set(cost.claimId, await prepareEmployeeCompensationSettlement(ctx, cost.submissionId, cost.claimId, tx, "view"));
      settlements.set(cost.claimId, await getEmployeeCompensationPaymentWorkspace(ctx, { id: cost.submissionId, claimId: cost.claimId }, { db: repository.runner(), requestId: deps.requestId }));
    }
    const items = rows.map(row => {
      const source = sources.get(row.employeeCost.claimId), settlement = settlements.get(row.employeeCost.claimId);
      if (!source || !settlement) throw new CompanyExpenseAccessError();
      const { cost, recognition, journal } = actualCost(source, row.employeeCostId);
      return { id: row.id, version: row.version, planVersion: row.planVersion, employeeCostId: cost.id, submissionId: cost.submissionId, claimId: cost.claimId,
        runId: source.row.runId, state: row.state, dataClass: "STAFF_COMPENSATION" as const,
        active: current.get(cost.id)?.state === "ATTACHED" && current.get(cost.id)?.companyExpenseId === input.companyExpenseId,
        ...Money.of(cost.amount, cost.currency).toJSON(), transactionId: recognition.transactionId, sourceReversed: journal.reversedByTransactions.length > 0,
        reason: row.reason, at: row.createdAt.toISOString(), settlement: { scope: "EMPLOYEE_CLAIM" as const, value: { id: settlement.id, claimId: settlement.claimId,
          earned: settlement.earned, outstanding: settlement.outstanding, blocked: settlement.blocked, payments: settlement.payments, next: settlement.next } } };
    });
    for (const source of sources.values()) await source.recheckSettlement(await finance.clock());
    await salaryAccess(ctx, repository);await recheckCompanyExpenseAccess(ctx, tx, plan, "view");
    return { items, next: history.length > 50 ? rows.at(-1)!.id : null };
  });
}
