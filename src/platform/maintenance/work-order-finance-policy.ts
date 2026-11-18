import { Prisma } from "@prisma/client";
import { z } from "zod";
import { ExpenseRepository } from "@/modules/finance/infrastructure/expense-repository";
import { SupplierInvoiceRepository } from "@/modules/finance/infrastructure/supplier-invoice-repository";
import { ExpenseAllocationConfigurationError } from "@/modules/finance/domain/configured-finance-rules";
import { ExpensePolicyUnavailableError, preparePropertyCostSubmissionPolicy } from "@/modules/finance/application/expense-submission-policy";
import { WorkOrderConflictError } from "@/modules/maintenance/domain/work-order";
import type { WorkOrderFinanceIntent } from "@/modules/maintenance/domain/work-order-finance";
import type { Resource } from "@/platform/authz/authorize";
import type { AccountActorContext } from "@/platform/authz/session-context";
import type { TenantTransaction } from "@/platform/db/tenant";

type Estimate = Extract<WorkOrderFinanceIntent, { kind: "estimate" }>;

export async function workOrderCostPolicy(actor: AccountActorContext, tx: TenantTransaction, resource: Resource, now: Date,
  task: { id: string; propertyId: string; reservationId: string | null; property: { timezone: string } }, fields: Estimate["fields"], revision: number) {
  try {
    return await preparePropertyCostSubmissionPolicy(actor, {
      id: task.id, propertyId: task.propertyId, reservationId: task.reservationId,
      amount: new Prisma.Decimal(fields.amount), currency: fields.currency, category: fields.category,
      occurredOn: new Date(fields.occurredOn), purpose: fields.purpose, emergency: false, property: task.property
    }, resource, tx, now, { taskId: task.id, estimateRevision: revision }, { discloseOwnerSlice: true });
  } catch (error) {
    if (error instanceof ExpensePolicyUnavailableError || error instanceof ExpenseAllocationConfigurationError || error instanceof z.ZodError)
      throw new WorkOrderConflictError();
    throw error;
  }
}

export async function lockWorkOrderFinancialSource(tx: TenantTransaction, organizationId: string, kind: "invoice" | "expense", sourceId: string) {
  if (kind === "expense") await new ExpenseRepository(tx, organizationId).lock(sourceId);
  else await new SupplierInvoiceRepository(tx, organizationId).lock(sourceId);
}
