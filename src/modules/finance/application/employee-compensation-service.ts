import { z } from "zod";
import { prisma } from "@/platform/db/client";
import { withTenant, type TenantTransaction, type TenantTransactionRunner } from "@/platform/db/tenant";
import { ConfigRuleRepository } from "@/platform/config/config-rule-repository";
import type { Resource } from "@/platform/authz/authorize";
import { present, catalogFieldPolicy } from "@/platform/authz/present";
import { Money } from "@/platform/money/money";
import { writeAuditEvent } from "@/platform/audit/audit-writer";
import { employeeCompensationAmount, employeeCompensationBasisSchema } from "../domain/employee-compensation";
import { EmployeeCompensationRepository } from "../infrastructure/employee-compensation-repository";
import { FinanceRepository } from "../infrastructure/finance-repository";
import { recheckFinanceAuthorization, type FinanceActorContext } from "./finance-access";
import { validateEmployeeCompensationAssignment, validateEmployeeCompensationRate,employeeCompensationContractResource } from "./employee-compensation-source";
import { EmployeeCompensationAccessError, EmployeeCompensationSourceUnavailableError } from "../domain/employee-compensation";

export { EmployeeCompensationAccessError, EmployeeCompensationSourceUnavailableError } from "../domain/employee-compensation";
export const employeeCompensationPreviewInput = z.object({ assignmentId: z.uuid(), earnedAt: z.iso.datetime({ offset: true }),
  basis: employeeCompensationBasisSchema }).strict();

/** Preview a contract with explicit units. This does not approve work, accrue a claim, or move money. */
export async function previewEmployeeCompensation(ctx: FinanceActorContext, raw: unknown, deps: { db?: TenantTransactionRunner; requestId?: string } = {}) {
  const input = employeeCompensationPreviewInput.parse(raw);
  return withTenant(deps.db ?? prisma, ctx.organizationId, tx => previewEmployeeCompensationInTransaction(ctx, input, tx, deps));
}

/** Internal financial sources compose in one tenant transaction, including their private read audit. */
export async function previewEmployeeCompensationInTransaction(ctx: FinanceActorContext, input: z.infer<typeof employeeCompensationPreviewInput>,
  tx: TenantTransaction, deps: { requestId?: string } = {}, completedJob?: { taskId: string; personId: string; completedAt: Date }) {
    const earnedAt = new Date(input.earnedAt);
    const repository = new EmployeeCompensationRepository(tx, ctx.organizationId), finance = new FinanceRepository(tx, ctx.organizationId);
    const source = await repository.source(input.assignmentId, earnedAt);
    if (!source?.rate) throw new EmployeeCompensationAccessError();
    const { assignment, rate, property } = source;
    if (completedJob && (input.basis.mode !== "PER_JOB" || input.basis.jobs !== "1" || completedJob.personId !== assignment.personId ||
      completedJob.completedAt.getTime() !== earnedAt.getTime())) throw new EmployeeCompensationSourceUnavailableError();
    const resource:Resource=employeeCompensationContractResource(ctx.organizationId,source,earnedAt,completedJob?.taskId);
    const check = async (amount?: Money) => recheckFinanceAuthorization(ctx, tx, await finance.clock(), [
      { action: "view", resource },
      ...(amount ? [{ action: "view" as const, resource: { ...resource, amount: amount.toJSON().amount } }] : [])
    ], new EmployeeCompensationAccessError());
    await check();
    validateEmployeeCompensationAssignment(source, earnedAt);
    const rule = await new ConfigRuleRepository(tx, ctx.organizationId).resolve({ key: "staff.compensation",
      scopes: [{ scopeType: "role_assignment", scopeId: assignment.id }], asOf: earnedAt });
    validateEmployeeCompensationRate(source, rule);
    if (!rule) throw new EmployeeCompensationSourceUnavailableError();
    const amount = employeeCompensationAmount({ mode: rate.mode, amount: Money.of(rate.amount.toString(), rate.currency) }, input.basis);
    const recheckSource = async () => {
      if (JSON.stringify(await repository.source(input.assignmentId, earnedAt)) !== JSON.stringify(source)) throw new EmployeeCompensationAccessError();
      const currentRule = await new ConfigRuleRepository(tx, ctx.organizationId).resolve({ key: "staff.compensation",
        scopes: [{ scopeType: "role_assignment", scopeId: assignment.id }], asOf: earnedAt });
      if (JSON.stringify(currentRule) !== JSON.stringify(rule)) throw new EmployeeCompensationSourceUnavailableError();
    };
    await recheckSource();
    await check(amount);
    await writeAuditEvent(tx, { organizationId: ctx.organizationId, actorId: ctx.actorId, action: "team.compensation.preview", resourceType: "team_member",
      resourceId: rate.id, propertyScopeId: property?.id, after: { personId: assignment.personId, assignmentId: assignment.id, compensationId: rate.id,
        configRuleId: rule.id, compensationVersion: rate.version, configVersion: rule.version, earnedAt: earnedAt.toISOString(), kind: "CONTRACTUAL_ESTIMATE" },
      reason: "Viewed an authorized contractual compensation estimate", requestId: deps.requestId ?? crypto.randomUUID(), occurredAt: await finance.clock() });
    await recheckSource();
    await check(amount);
    const data = { kind: "CONTRACTUAL_ESTIMATE" as const, assignmentId: assignment.id, personId: assignment.personId, compensationId: rate.id,
      compensationVersion: rate.version, configRuleId: rule.id, configVersion: rule.version, earnedAt: earnedAt.toISOString(),
      mode: rate.mode, rate: Money.of(rate.amount.toString(), rate.currency).toJSON(), basis: input.basis, amount: amount.toJSON() };
    return present({ ...ctx.authContext, visibleDataClasses: new Set() }, "view", { ...resource, data }, catalogFieldPolicy<typeof data>("staff_compensation"));
}
