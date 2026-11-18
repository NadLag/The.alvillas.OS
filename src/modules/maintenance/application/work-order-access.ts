import type { AccountActorContext } from "@/platform/authz/session-context";
import { captureAuthorizationCap, restoreAuthorizationCap } from "@/platform/authz/authorization-cap";
import type { TenantTransaction } from "@/platform/db/tenant";
import { jsonbFingerprint } from "@/platform/http/command-fingerprint";
import { nativeMaintenanceIssue } from "@/platform/maintenance/issue-sources";
import { nativeMaintenanceWorkOrderTask } from "@/platform/maintenance/work-order-source";
import { MaintenanceIssueAccessError } from "../domain/issue-context";
import { WorkOrderAccessError, workOrderRegistrationReceiptSchema } from "../domain/work-order";
import { WorkOrderRepository } from "../infrastructure/work-order-repository";

export function workOrderActor(context: AccountActorContext) {
  if (context.actorId !== context.authContext.userAccountId || context.organizationId !== context.authContext.organizationId)
    throw new WorkOrderAccessError();
  return { ...context, authContext: restoreAuthorizationCap(captureAuthorizationCap(context.authContext)) };
}

export async function findRegisteredWorkOrder(actor: AccountActorContext, tx: TenantTransaction, taskId: string,
  action: "view" | "edit" | "assign" = "view") {
  const original = await new WorkOrderRepository(tx, actor.organizationId).original(taskId);
  if (!original) throw new WorkOrderAccessError();
  const order = workOrderRegistrationReceiptSchema.parse(original);
  try {
    const [issue, task] = await Promise.all([
      nativeMaintenanceIssue(actor, tx, order.intent.issueId, action === "edit" ? "edit" : "view"),
      nativeMaintenanceWorkOrderTask(actor, tx, taskId, action)
    ]);
    if (order.propertyId !== task.task.propertyId || issue.row.propertyId !== order.propertyId)
      throw new WorkOrderAccessError();
    return {
      issue, task, fingerprint: jsonbFingerprint({ issue: issue.fingerprint, task: task.fingerprint, order }),
      recheck: async () => { await issue.recheck(); await task.recheck(); }
    };
  } catch (error) {
    if (error instanceof MaintenanceIssueAccessError) throw new WorkOrderAccessError();
    throw error;
  }
}
