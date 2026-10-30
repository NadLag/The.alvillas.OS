import { z } from "zod";
import { prisma } from "@/platform/db/client";
import { withTenant, type TenantTransactionRunner } from "@/platform/db/tenant";
import { Money } from "@/platform/money/money";
import { writeAuditEvent } from "@/platform/audit/audit-writer";
import { EmployeeCompensationRepository } from "../infrastructure/employee-compensation-repository";
import { FinanceRepository } from "../infrastructure/finance-repository";
import { EmployeeCompensationAccessError, previewEmployeeCompensationInTransaction } from "./employee-compensation-service";
import { recheckFinanceAuthorization, type FinanceActorContext } from "./finance-access";
import { validateEmployeeCompletedWorkSource } from "./employee-compensation-source";

export const employeeCompletedWorkInput = z.object({ taskId: z.uuid(), assignmentId: z.uuid(), confirmedAssignment: z.literal(true) }).strict();

/** Bind one recorded completed job to its performer's contract; do not recognize a payable. */
export async function previewEmployeeCompletedWork(ctx: FinanceActorContext, raw: unknown, deps: { db?: TenantTransactionRunner; requestId?: string } = {}) {
  const input = employeeCompletedWorkInput.parse(raw);
  const requestId = deps.requestId ?? crypto.randomUUID();
  return withTenant(deps.db ?? prisma, ctx.organizationId, async tx => {
    const repository = new EmployeeCompensationRepository(tx, ctx.organizationId), finance = new FinanceRepository(tx, ctx.organizationId);
    const task = await repository.completedWork(input.taskId);
    if (!task || task.state !== "COMPLETED" || !task.completedAt || !task.completedByPersonId) throw new EmployeeCompensationAccessError();
    const source = await repository.source(input.assignmentId, task.completedAt);
    if (!source?.rate || source.assignment.personId !== task.completedByPersonId) throw new EmployeeCompensationAccessError();
    const { assignment, rate } = source;
    const resource = { type: "staff_compensation", id: assignment.personId, organizationId: ctx.organizationId, assignedPersonId: assignment.personId,
      propertyId: task.propertyId, city: task.property.cityId, region: task.property.regionId, jobId: task.id,
      amount: Money.of(rate.amount.toString(), rate.currency).toJSON().amount, occurredAt: task.completedAt };
    const recheck = async () => recheckFinanceAuthorization(ctx, tx, await finance.clock(), [{ action: "view", resource }], new EmployeeCompensationAccessError());
    await recheck();
    const { evidence, event } = validateEmployeeCompletedWorkSource(task, source);
    const estimate = await previewEmployeeCompensationInTransaction(ctx, { assignmentId: assignment.id, earnedAt: task.completedAt.toISOString(),
      basis: { mode: "PER_JOB", jobs: "1" } }, tx, { requestId }, { taskId: task.id, personId: assignment.personId, completedAt: task.completedAt });
    await writeAuditEvent(tx, { organizationId: ctx.organizationId, actorId: ctx.actorId, action: "team.compensation.completed_work.preview", resourceType: "team_member",
      resourceId: assignment.personId, propertyScopeId: task.propertyId, after: { personId: assignment.personId, assignmentId: assignment.id, taskId: task.id,
        completionEventId: event.id, completionVersion: event.version, completionMethod: evidence.completion_source, kind: "COMPLETED_JOB_ESTIMATE" },
      reason: "Viewed an authorized completed-work compensation estimate", requestId, occurredAt: await finance.clock() });
    if (JSON.stringify(await repository.completedWork(task.id)) !== JSON.stringify(task) ||
      JSON.stringify(await repository.source(assignment.id, task.completedAt)) !== JSON.stringify(source)) throw new EmployeeCompensationAccessError();
    await recheckFinanceAuthorization(ctx, tx, await finance.clock(), [{ action: "view", resource }], new EmployeeCompensationAccessError());
    return { ...estimate, kind: "COMPLETED_JOB_ESTIMATE" as const, taskId: task.id, completionEventId: event.id, completionVersion: event.version,
      recordedCompletionAt: task.completedAt.toISOString(), performedByPersonId: evidence.completed_by_person_id, completionMethod: evidence.completion_source };
  });
}
