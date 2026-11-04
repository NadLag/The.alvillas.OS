import { z } from "zod";
import { taskResource } from "@/platform/authz/task-resource";
import { recheckAccountAuthorization } from "@/platform/authz/current-authority";
import { commandFingerprint } from "@/platform/http/command-fingerprint";
import { FinanceRepository } from "@/modules/finance/infrastructure/finance-repository";
import { VarianceWorkflowRepository } from "@/modules/finance/infrastructure/variance-workflow-repository";
import { VarianceWorkflowConflictError, VarianceWorkflowSourceError } from "@/modules/finance/domain/variance-workflow";
import type { VarianceSourceAuthority } from "@/modules/finance/application/variance-workflow-service";
import { stocktakeReconciliation } from "./stocktake-reconciliation";

/** Physical quantity access stays operational and never grants financial source access. */
export const authorizeInventoryVarianceSource: VarianceSourceAuthority = async (ctx, reference, tx, access) => {
  if (reference.provider !== "INVENTORY") throw new VarianceWorkflowSourceError();
  const repository = new VarianceWorkflowRepository(tx, ctx.organizationId), finance = new FinanceRepository(tx, ctx.organizationId);
  const original = await repository.originalStocktake(reference.id);
  if (!original?.task || !original.property || original.task.propertyId !== original.property.id) throw new VarianceWorkflowSourceError();
  const resource = taskResource({ ...original.task, property: original.property }), signature = commandFingerprint(resource);
  type Check = Parameters<typeof recheckAccountAuthorization>[3][number];
  const checks: Check[] = [{ action: "view", resource }];
  if (access === "ASSIGN") checks.push({ action: "assign", resource });
  if (access === "RESOLVE" || access === "REOPEN") checks.push({ action: "edit", resource });
  if (access === "history") checks.push({ action: "view", resource: { ...resource, type: "audit_log", dataClass: "operational" } });
  const recheck = async () => {
    const current = await repository.originalStocktake(reference.id);
    if (!current?.task || !current.property || commandFingerprint(taskResource({ ...current.task, property: current.property })) !== signature) throw new VarianceWorkflowConflictError();
    await recheckAccountAuthorization(ctx, tx, await finance.clock(), checks, new VarianceWorkflowSourceError());
  };
  await recheck();
  const unit = z.object({ item: z.object({ unit: z.string().nullable() }) }).parse(original.configSnapshot).item.unit;
  const plan = stocktakeReconciliation({ observation: { id: original.id, organizationId: original.organizationId, locationId: original.locationId,
    itemId: original.itemId, expectedRevision: original.expectedRevision.toString(), revision: original.revision.toString(),
    expectedQuantity: original.expectedQuantity.toFixed(0), countedQuantity: original.countedQuantity.toString() },
    movement: original.movement ? { id: original.movement.id, organizationId: original.movement.organizationId, locationId: original.movement.locationId,
      itemId: original.movement.itemId, stocktakeId: original.movement.stocktakeId, revision: original.movement.revision.toString(),
      quantityDelta: original.movement.quantityDelta.toFixed(0) } : null, unit, reason: original.note }).plan;
  return { facts: { kind: "QUANTITY", unit: plan.unit, currency: null, expected: plan.expected, actual: plan.actual, variance: plan.variance }, recheck };
};
