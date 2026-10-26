import { z } from "zod";
import { authorize, type Resource } from "@/platform/authz/authorize";
import { authContextForAccountInTransaction } from "@/platform/authz/account-context";
import { prisma } from "@/platform/db/client";
import { withTenant, type TenantTransaction, type TenantTransactionRunner } from "@/platform/db/tenant";
import { writeAuditEvent } from "@/platform/audit/audit-writer";
import { Money } from "@/platform/money/money";
import { expenseDraftSchema, type ExpenseDraftInput } from "../domain/expense";
import { ExpenseRepository, type ExpenseRecord } from "../infrastructure/expense-repository";
import { FinanceRepository } from "../infrastructure/finance-repository";
import type { FinanceActorContext } from "./finance-access";

type Deps = { db?: TenantTransactionRunner; requestId?: string };
export class ExpenseAccessError extends Error {}
export class ExpenseConflictError extends Error {}
export class ExpenseConfigurationError extends Error {}
const updateSchema = z.object({ id: z.uuid(), expectedVersion: z.number().int().positive(), draft: expenseDraftSchema }).strict();

function assertActor(ctx: FinanceActorContext) {
  if (ctx.organizationId !== ctx.authContext.organizationId || ctx.actorId !== ctx.authContext.userAccountId) throw new ExpenseAccessError();
}
type Property = NonNullable<Awaited<ReturnType<ExpenseRepository["property"]>>>;
function resource(ctx: FinanceActorContext, property: Property, facts: { id: string; amount: string; reservationId?: string | null; state: string; occurredOn: Date; createdBy: string }): Resource {
  return { type: "expense", organizationId: ctx.organizationId, id: facts.id, financialRecordId: facts.id,
    propertyId: property.id, reservationId: facts.reservationId, city: property.cityId ?? property.city, region: property.regionId ?? property.region,
    status: facts.state, amount: facts.amount, occurredAt: facts.occurredOn, assignedUserAccountId: facts.createdBy, dataClass: "financial" };
}
async function current(ctx: FinanceActorContext, tx: TenantTransaction, at: Date): Promise<FinanceActorContext> {
  return { ...ctx, authContext: { ...await authContextForAccountInTransaction(tx, ctx.organizationId, ctx.actorId, at), personId: ctx.authContext.personId } };
}
async function validateFacts(ctx: FinanceActorContext, tx: TenantTransaction, input: ExpenseDraftInput, id: string, now: Date, action: "create" | "edit") {
  const repository = new ExpenseRepository(tx, ctx.organizationId), property = await repository.property(input.propertyId);
  if (!property) throw new ExpenseAccessError();
  const target = resource(ctx, property, { id, amount: input.amount, reservationId: input.reservationId, state: "DRAFT",
    occurredOn: new Date(`${input.occurredOn}T00:00:00.000Z`), createdBy: ctx.actorId });
  if (!authorize(ctx.authContext, action, target, now) || !authorize(ctx.authContext, "view",
    { ...target, id: input.fundingAccountId, financialRecordId: input.fundingAccountId, type: "financial_transaction" }, now)) throw new ExpenseAccessError();
  const currency = await repository.currency(input.currency), money = Money.of(input.amount, input.currency);
  if (!currency || currency.minorUnit > 2 || money.amount.decimalPlaces() > currency.minorUnit) throw new ExpenseConfigurationError("Expense currency precision is unavailable");
  if (input.reservationId && (await repository.reservation(input.reservationId))?.propertyId !== property.id) throw new ExpenseAccessError();
  const funding = await new FinanceRepository(tx, ctx.organizationId).findLedgerAccountById(input.fundingAccountId);
  if (!funding || funding.archivedAt || !["ASSET", "ASSET_LOCATION"].includes(funding.accountType) || funding.normalSide !== "DEBIT" || funding.code.startsWith("CASH_CUSTODY_"))
    throw new ExpenseConfigurationError("Expense funding account requires its authorized payment workflow");
  if (!authorize(ctx.authContext, "view", { ...target, id: funding.id, financialRecordId: funding.id, type: "financial_transaction" }, now)) throw new ExpenseAccessError();
  return { target, property };
}
function facts(row: ExpenseRecord) {
  return { id: row.id, propertyId: row.propertyId, reservationId: row.reservationId, fundingAccountId: row.fundingAccountId,
    amount: row.amount.toFixed(2), currency: row.currency, category: row.category, purpose: row.purpose,
    occurredOn: row.occurredOn.toISOString().slice(0,10), emergency: row.emergency, version: row.version, state: row.state };
}
function sameDraft(row: ExpenseRecord, input: ExpenseDraftInput) {
  return row.propertyId === input.propertyId && row.reservationId === (input.reservationId ?? null) && row.fundingAccountId === input.fundingAccountId &&
    row.amount.eq(input.amount) && row.currency === input.currency && row.category === input.category && row.purpose === input.purpose &&
    row.occurredOn.toISOString().slice(0,10) === input.occurredOn && row.emergency === input.emergency;
}
export async function createExpenseDraft(ctx: FinanceActorContext, raw: unknown, deps: Deps = {}) {
  assertActor(ctx); const input = expenseDraftSchema.parse(raw);
  return withTenant(deps.db ?? prisma, ctx.organizationId, async tx => {
    const repository = new ExpenseRepository(tx, ctx.organizationId); await repository.lock(`draft:${input.idempotencyKey}`);
    const clock = await repository.clock(); ctx = await current(ctx, tx, clock.now);
    await validateFacts(ctx, tx, input, clock.id, clock.now, "create");
    const previous = await repository.byKey(input.idempotencyKey);
    if (previous) {
      if (previous.createdBy !== ctx.actorId || !sameDraft(previous, input)) throw new ExpenseConflictError();
      return { id: previous.id, version: previous.version, idempotent: true };
    }
    const row = await repository.create(clock.id, input, ctx.actorId);
    await writeAuditEvent(tx, { organizationId: ctx.organizationId, actorId: ctx.actorId, action: "expense.created", resourceType: "expense",
      resourceId: row.id, propertyScopeId: row.propertyId, after: facts(row), reason: input.reason, requestId: deps.requestId ?? crypto.randomUUID(), occurredAt: clock.now });
    return { id: row.id, version: row.version, idempotent: false };
  });
}
export async function updateExpenseDraft(ctx: FinanceActorContext, raw: unknown, deps: Deps = {}) {
  assertActor(ctx); const { id, expectedVersion, draft: input } = updateSchema.parse(raw);
  return withTenant(deps.db ?? prisma, ctx.organizationId, async tx => {
    const repository = new ExpenseRepository(tx, ctx.organizationId); await repository.lock(id);
    const clock = await repository.clock(); ctx = await current(ctx, tx, clock.now);
    const previous = await repository.find(id);
    if (!previous || previous.property.archivedAt || !authorize(ctx.authContext, "edit", resource(ctx, previous.property,
      { ...previous, amount: previous.amount.toString() }), clock.now)) throw new ExpenseAccessError();
    await validateFacts(ctx, tx, input, id, clock.now, "edit");
    if (previous.idempotencyKey !== input.idempotencyKey || previous.version !== expectedVersion || previous.state !== "DRAFT") throw new ExpenseConflictError();
    if ((await repository.updateDraft(id, expectedVersion, input, ctx.actorId)).count !== 1) throw new ExpenseConflictError();
    const row = await repository.find(id); if (!row) throw new ExpenseConflictError();
    await writeAuditEvent(tx, { organizationId: ctx.organizationId, actorId: ctx.actorId, action: "expense.updated", resourceType: "expense", resourceId: id,
      propertyScopeId: row.propertyId, before: facts(previous), after: facts(row), reason: input.reason, requestId: deps.requestId ?? crypto.randomUUID(), occurredAt: clock.now });
    return { id, version: row.version };
  });
}
