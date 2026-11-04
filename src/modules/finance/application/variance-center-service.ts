import { randomUUID } from "node:crypto";
import { withTenant, type TenantTransaction, type TenantTransactionRunner } from "@/platform/db/tenant";
import { authContextForAccountInTransaction } from "@/platform/authz/account-context";
import { recheckAccountAuthorization } from "@/platform/authz/current-authority";
import { authorizationScopeStamp } from "@/platform/authz/authority-stamp";
import { writeAuditEvent } from "@/platform/audit/audit-writer";
import { FinanceRepository } from "../infrastructure/finance-repository";
import { VarianceCenterRepository } from "../infrastructure/variance-center-repository";
import { VarianceCenterAccessError, VarianceCenterCursorError, includeVarianceCenterRow, varianceCenterFilterSchema,
  varianceCenterInputSchema, varianceCenterPageSchema, type VarianceCenterProvider, type VarianceCenterRow } from "../domain/variance-center";
import { varianceDetailSchema } from "../domain/variance-workspace";
import { VarianceWorkflowSourceError } from "../domain/variance-workflow";
import { BankReconciliationAccessError } from "../domain/bank-reconciliation";
import { EmployeeCompensationRunAccessError } from "../domain/employee-compensation-run";
import { captureVarianceWorkflowActor, inspectVarianceWorkflowSource, type VarianceSourceAuthority } from "./variance-workflow-service";
import { encodeVarianceCenterCursor, decodeVarianceCenterCursor } from "./variance-center-cursor";
import type { FinanceActorContext } from "./finance-access";

type Deps = { db: TenantTransactionRunner; authorizeSource: VarianceSourceAuthority; requestId?: string; env?: NodeJS.ProcessEnv };
const roots: Record<VarianceCenterProvider, readonly string[]> = { OTA: ["financial_transaction"], BANK: ["bank_statement", "financial_transaction"],
  STAFF: ["employee_payable", "staff_compensation", "financial_transaction", "expense"], INVENTORY: ["task"] };

async function gate(ctx: FinanceActorContext, provider: VarianceCenterProvider, tx: TenantTransaction) {
  const now = await new FinanceRepository(tx, ctx.organizationId).clock();
  await recheckAccountAuthorization(ctx, tx, now, roots[provider].map(type => ({ action: "view" as const,
    resource: { type, organizationId: ctx.organizationId, dataClass: provider === "INVENTORY" ? "operational" as const : "financial" as const }, organizationOnly: true })), new VarianceCenterAccessError());
  return { now, current: { ...await authContextForAccountInTransaction(tx, ctx.organizationId, ctx.actorId), personId: ctx.authContext.personId } };
}

/** Organization browsing never replaces or expands the independent native source restrictions. */
export async function readVarianceCenter(context: FinanceActorContext, raw: unknown, deps: Deps) {
  const ctx = captureVarianceWorkflowActor(context), input = varianceCenterInputSchema.parse(raw), filter = varianceCenterFilterSchema.parse({ provider: input.provider, status: input.status, assignment: input.assignment });
  return withTenant(deps.db, ctx.organizationId, async tx => {
    const authority = await gate(ctx, input.provider, tx);
    const position = input.cursor ? decodeVarianceCenterCursor(input.cursor, ctx, authority.current, filter, authority.now, deps.env) : undefined;
    const candidates = await new VarianceCenterRepository(tx, ctx.organizationId).candidates(input.provider, position), page = candidates.slice(0, 20);
    const results: VarianceCenterRow[] = [], finalChecks: Array<() => Promise<void>> = [];
    for (const candidate of page) {
      try {
        const source = await inspectVarianceWorkflowSource(ctx, { provider: input.provider, id: candidate.id }, tx, deps, "view");
        const detail = varianceDetailSchema.parse({ ...source.projection, facts: source.display });
        if (includeVarianceCenterRow(detail, filter, ctx.actorId)) { results.push({ reference: candidate.reference, detail }); finalChecks.push(source.recheck); }
      } catch (error) {
        if (!(error instanceof VarianceWorkflowSourceError || error instanceof BankReconciliationAccessError || error instanceof EmployeeCompensationRunAccessError)) throw error;
      }
    }
    // Keep response construction strict and bounded, including an empty filtered page.
    const nextPosition = candidates.length > 20 ? { id: page[page.length - 1].id, at: page[page.length - 1].at } : null;
    await writeAuditEvent(tx, { organizationId: ctx.organizationId, actorId: ctx.actorId, action: "reconciliation.variance_center.read",
      resourceType: "variance_workflow_queue", resourceId: ctx.actorId, after: { provider: input.provider, status: input.status, assignment: input.assignment, returned: results.length },
      requestId: deps.requestId ?? randomUUID(), occurredAt: await new FinanceRepository(tx, ctx.organizationId).clock() });
    for (const check of finalChecks) await check();
    const current = await gate(ctx, input.provider, tx);
    if (authorizationScopeStamp(current.current) !== authorizationScopeStamp(authority.current)) throw new VarianceCenterCursorError();
    return varianceCenterPageSchema.parse({ items: results,
      next: nextPosition ? encodeVarianceCenterCursor(ctx, current.current, filter, nextPosition, current.now, deps.env) : null });
  }, { timeout: 120000 });
}
