import type { TenantTransaction } from "@/platform/db/tenant";
import { ContractorAssignmentRepository } from "@/modules/maintenance/infrastructure/contractor-assignment-repository";
import { maintenanceSlaMilestone } from "@/modules/maintenance/domain/contractor-sla";

export async function currentSupplierSlaBreaches(tx: TenantTransaction, organizationId: string, input: {
  taskId: string; assignedAt: Date; responseDueAt: Date; completionDueAt: Date; completedAt: Date | null
}, now: Date) {
  const { responseAt, closedAt } = await new ContractorAssignmentRepository(tx, organizationId)
    .milestones(input.taskId, input.assignedAt, now);
  const at = closedAt ?? now;
  const completed = input.completedAt && input.completedAt >= input.assignedAt && input.completedAt <= at ? input.completedAt : null;
  return [
    ...(maintenanceSlaMilestone(input.responseDueAt, responseAt && responseAt <= at ? responseAt : null, at, !!closedAt) === "BREACHED" ? ["response"] : []),
    ...(maintenanceSlaMilestone(input.completionDueAt, completed, at, !!closedAt) === "BREACHED" ? ["completion"] : [])
  ];
}
