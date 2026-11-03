import { createHash, randomUUID } from "node:crypto";
import type { CompanyExpenseCommandReceipt } from "@prisma/client";
import { prisma } from "@/platform/db/client";
import { withTenant, type TenantTransactionRunner } from "@/platform/db/tenant";
import { writeAuditEvent } from "@/platform/audit/audit-writer";
import { companyExpenseCommandSchema, companyExpenseCommandRecoverySchema, companyExpenseCommandResultSchema, companyExpenseCommandSuccessSchema, type CompanyExpenseCommand } from "../domain/company-expense-command";
import { CompanyExpenseAccessError, CompanyExpenseChangedError, CompanyExpenseConfigurationError } from "../domain/company-expense";
import { CompanyExpenseCommandRepository } from "../infrastructure/company-expense-command-repository";
import { CompanyExpenseRepository } from "../infrastructure/company-expense-repository";
import { FinanceRepository } from "../infrastructure/finance-repository";
import { createCompanyExpensePlan, reviseCompanyExpensePlan, cancelCompanyExpensePlan, recheckCompanyExpenseAccess } from "./company-expense-service";
import { changeCompanyExpenseInvoiceSource } from "./company-expense-invoice-service";
import { changeCompanyExpenseCompensationSource } from "./company-expense-compensation-service";
import { recheckFinanceAuthorization, type FinanceActorContext } from "./finance-access";

type Deps = { db?: TenantTransactionRunner; requestId?: string };
function receipt(row: CompanyExpenseCommandReceipt, idempotent: boolean) {
  return companyExpenseCommandSuccessSchema.parse({ requestId: row.id, idempotencyKey: row.idempotencyKey, operation: row.operation, state: "SUCCEEDED", failureCode: null,
    companyExpenseId: row.companyExpenseId, resultId: row.resultId, version: row.resultVersion, idempotent });
}
async function recheckReceipt(ctx: FinanceActorContext, row: CompanyExpenseCommandReceipt, repository: CompanyExpenseCommandRepository) {
  if (row.createdBy !== ctx.actorId) throw new CompanyExpenseAccessError();
  const plans = new CompanyExpenseRepository(repository.tx, ctx.organizationId);await plans.lockPlanRead(row.companyExpenseId);
  const plan = await plans.latest(row.companyExpenseId);
  if (!plan) throw new CompanyExpenseAccessError();
  await recheckCompanyExpenseAccess(ctx, repository.tx, plan, "view");
  if (row.dataClass === "STAFF_COMPENSATION") await recheckFinanceAuthorization(ctx, repository.tx, await new FinanceRepository(repository.tx, ctx.organizationId).clock(), [
    { action: "view", resource: { type: "staff_compensation", organizationId: ctx.organizationId, dataClass: "financial" }, organizationOnly: true }
  ], new CompanyExpenseAccessError());
}
async function executeNative(ctx: FinanceActorContext, command: CompanyExpenseCommand, repository: CompanyExpenseCommandRepository, deps: Deps) {
  const options = { db: repository.runner(), requestId: deps.requestId };
  switch (command.operation) {
    case "CREATE": {
      const result = await createCompanyExpensePlan(ctx, { ...command.input, idempotencyKey: command.idempotencyKey }, options);
      const row = await repository.revision(result.id, 1);if (!row) throw new CompanyExpenseChangedError();
      return { companyExpenseId: result.id, resultId: row.id, resultVersion: row.version, dataClass: row.dataClass };
    }
    case "REVISE": case "CANCEL": {
      const result = command.operation === "REVISE" ? await reviseCompanyExpensePlan(ctx, command.input, options) : await cancelCompanyExpensePlan(ctx, command.input, options);
      const row = await repository.revision(result.id, result.version);if (!row) throw new CompanyExpenseChangedError();
      return { companyExpenseId: result.id, resultId: row.id, resultVersion: row.version, dataClass: row.dataClass };
    }
    case "INVOICE_SOURCE": {
      const result = await changeCompanyExpenseInvoiceSource(ctx, command.input, options), row = await repository.invoiceResult(result.id);
      if (!row) throw new CompanyExpenseChangedError();return { companyExpenseId: row.companyExpenseId, resultId: row.id, resultVersion: row.version, dataClass: row.dataClass };
    }
    case "EMPLOYEE_SOURCE": {
      const result = await changeCompanyExpenseCompensationSource(ctx, command.input, options), row = await repository.employeeResult(result.id);
      if (!row) throw new CompanyExpenseChangedError();return { companyExpenseId: row.companyExpenseId, resultId: row.id, resultVersion: row.version, dataClass: row.dataClass };
    }
  }
}
/** Only an acknowledgement of a real native result is persisted; command payloads stay out of browser storage. */
export async function executeCompanyExpenseCommand(ctx: FinanceActorContext, raw: unknown, deps: Deps = {}) {
  const command = companyExpenseCommandSchema.parse(raw), requestHash = createHash("sha256").update(JSON.stringify({ actorId: ctx.actorId, command })).digest("hex");
  return withTenant(deps.db ?? prisma, ctx.organizationId, async tx => {
    const repository = new CompanyExpenseCommandRepository(tx, ctx.organizationId);await repository.lock(command.idempotencyKey);
    const existing = await repository.byKey(command.idempotencyKey);
    if (existing) {
      await recheckReceipt(ctx, existing, repository);
      if (existing.requestHash !== requestHash || existing.operation !== command.operation) throw new CompanyExpenseChangedError();
      return receipt(existing, true);
    }
    const result = await executeNative(ctx, command, repository, deps), now = await new FinanceRepository(tx, ctx.organizationId).clock();
    const row = await repository.append({ idempotencyKey: command.idempotencyKey, requestHash, operation: command.operation, ...result, createdBy: ctx.actorId, createdAt: now });
    await writeAuditEvent(tx, { organizationId: ctx.organizationId, actorId: ctx.actorId, action: "company_expense.command_acknowledged", resourceType: "company_expense", resourceId: row.companyExpenseId,
      after: { receiptId: row.id, idempotencyKey: row.idempotencyKey, requestHash, operation: row.operation, resultId: row.resultId, version: row.resultVersion, dataClass: row.dataClass },
      reason: command.input.reason, requestId: deps.requestId ?? randomUUID(), occurredAt: now });
    if (command.operation === "REVISE" || command.operation === "CANCEL") {
      const checked = await repository.revision(row.companyExpenseId, row.resultVersion);
      if (!checked || checked.id !== row.resultId) throw new CompanyExpenseChangedError();
      await recheckCompanyExpenseAccess(ctx, tx, checked, command.operation === "REVISE" ? "edit" : "void");
    } else {
      // Native creation/source replay repeats its original fences without creating another business row.
      const checked = await executeNative(ctx, command, repository, deps);
      if (checked.resultId !== row.resultId || checked.resultVersion !== row.resultVersion) throw new CompanyExpenseChangedError();
    }
    await recheckReceipt(ctx, row, repository);return receipt(row, false);
  });
}
/** Share the execution lock: recovery must never report absence while an original write can still commit. */
export async function recoverCompanyExpenseCommand(ctx: FinanceActorContext, raw: unknown, deps: Deps = {}) {
  const input = companyExpenseCommandRecoverySchema.parse(raw);
  return withTenant(deps.db ?? prisma, ctx.organizationId, async tx => {
    const repository = new CompanyExpenseCommandRepository(tx, ctx.organizationId);
    const authority = ["company_expense", "financial_transaction"].map(type => ({ action: "view" as const, resource: { type, organizationId: ctx.organizationId, dataClass: "financial" as const }, organizationOnly: true }));
    await recheckFinanceAuthorization(ctx, tx, await new FinanceRepository(tx, ctx.organizationId).clock(), authority, new CompanyExpenseAccessError());
    await repository.lock(input.key);
    const row = await repository.byKey(input.key);
    if (!row) {
      await recheckFinanceAuthorization(ctx, tx, await new FinanceRepository(tx, ctx.organizationId).clock(), authority, new CompanyExpenseAccessError());
      return { request: null };
    }
    await recheckReceipt(ctx, row, repository);return { request: receipt(row, true) };
  });
}
/** Known rejected attempts are converted only after the entire native transaction has rolled back. */
export async function requestCompanyExpenseCommand(ctx: FinanceActorContext, raw: unknown, deps: Deps = {}) {
  const command = companyExpenseCommandSchema.parse(raw);
  try { return await executeCompanyExpenseCommand(ctx, command, deps); }
  catch (error) {
    if (error instanceof CompanyExpenseChangedError) return companyExpenseCommandResultSchema.parse({ requestId: deps.requestId ?? randomUUID(), idempotencyKey: command.idempotencyKey,
      operation: command.operation, state: "CONFLICT", failureCode: "SOURCE_CHANGED" });
    if (error instanceof CompanyExpenseConfigurationError) return companyExpenseCommandResultSchema.parse({ requestId: deps.requestId ?? randomUUID(), idempotencyKey: command.idempotencyKey,
      operation: command.operation, state: "FAILED", failureCode: "CONFIGURATION_UNAVAILABLE" });
    throw error;
  }
}
