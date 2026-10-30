import { z } from "zod";
import { prisma } from "@/platform/db/client";
import { withTenant, type TenantTransactionRunner } from "@/platform/db/tenant";
import { ConfigRuleRepository } from "@/platform/config/config-rule-repository";
import type { Resource } from "@/platform/authz/authorize";
import { present, catalogFieldPolicy } from "@/platform/authz/present";
import { Money } from "@/platform/money/money";
import { writeAuditEvent } from "@/platform/audit/audit-writer";
import { employeeCompensationAmount, employeeCompensationBasisSchema } from "../domain/employee-compensation";
import { EmployeeCompensationRepository } from "../infrastructure/employee-compensation-repository";
import { FinanceRepository } from "../infrastructure/finance-repository";
import { recheckFinanceAuthorization, type FinanceActorContext } from "./finance-access";

export class EmployeeCompensationAccessError extends Error {}
export class EmployeeCompensationSourceUnavailableError extends Error {}
export const employeeCompensationPreviewInput = z.object({ assignmentId: z.uuid(), earnedAt: z.iso.datetime({ offset: true }),
  basis: employeeCompensationBasisSchema }).strict();

/** Preview a contract with explicit units. This does not approve work, accrue a claim, or move money. */
export async function previewEmployeeCompensation(ctx: FinanceActorContext, raw: unknown, deps: { db?: TenantTransactionRunner; requestId?: string } = {}) {
  const input = employeeCompensationPreviewInput.parse(raw), earnedAt = new Date(input.earnedAt);
  return withTenant(deps.db ?? prisma, ctx.organizationId, async tx => {
    const repository = new EmployeeCompensationRepository(tx, ctx.organizationId), finance = new FinanceRepository(tx, ctx.organizationId);
    const source = await repository.source(input.assignmentId, earnedAt);
    if (!source?.rate) throw new EmployeeCompensationAccessError();
    const { assignment, rate, property, job, city, region } = source;
    const resource: Resource = { type: "staff_compensation", id: assignment.personId, organizationId: ctx.organizationId, dataClass: "financial",
      assignedPersonId: assignment.personId, amount: rate.amount.toFixed(2), occurredAt: earnedAt,
      propertyId: property?.id, region: region?.id ?? city?.regionId ?? property?.regionId,
      city: city?.id ?? property?.cityId,
      jobId: assignment.scopeType === "job" ? assignment.scopeId : undefined, reservationId: job?.reservationId };
    const check = async (amount?: Money) => recheckFinanceAuthorization(ctx, tx, await finance.clock(), [
      { action: "view", resource },
      ...(amount ? [{ action: "view" as const, resource: { ...resource, amount: amount.toJSON().amount } }] : [])
    ], new EmployeeCompensationAccessError());
    await check();
    if (assignment.validFrom > earnedAt || assignment.validTo && assignment.validTo <= earnedAt || assignment.archivedAt && assignment.archivedAt <= earnedAt ||
      assignment.person.archivedAt && assignment.person.archivedAt <= earnedAt || assignment.scopeType === "property" && !property || assignment.scopeType === "job" && (!job || !property) ||
      assignment.scopeType === "city" && !city || assignment.scopeType === "region" && !region ||
      !["organization", "property", "region", "city", "job"].includes(assignment.scopeType)) throw new EmployeeCompensationSourceUnavailableError();
    const rule = await new ConfigRuleRepository(tx, ctx.organizationId).resolve({ key: "staff.compensation",
      scopes: [{ scopeType: "role_assignment", scopeId: assignment.id }], asOf: earnedAt });
    const value = z.object({ mode: z.enum(["PER_JOB", "PER_MONTH", "PER_HOUR", "PERCENTAGE"]), amount: z.string(), currency: z.string() }).safeParse(rule?.parsedValue);
    if (!rule || !value.success || rule.id !== rate.configRuleId || rule.scopeType !== "role_assignment" || rule.scopeId !== assignment.id ||
      value.data.mode !== rate.mode || value.data.currency !== rate.currency || !Money.of(value.data.amount, rate.currency).equals(Money.of(rate.amount.toString(), rate.currency)) ||
      rule.effectiveFrom.getTime() !== rate.effectiveFrom.getTime()) throw new EmployeeCompensationSourceUnavailableError();
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
  });
}
