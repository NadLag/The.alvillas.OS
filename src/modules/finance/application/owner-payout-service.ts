import { z } from "zod";
import { prisma } from "@/platform/db/client";
import { withTenant, type TenantTransactionRunner } from "@/platform/db/tenant";
import { authorize, type Resource } from "@/platform/authz/authorize";
import { authContextForAccountInTransaction } from "@/platform/authz/account-context";
import { present } from "@/platform/authz/present";
import { writeAuditEvent } from "@/platform/audit/audit-writer";
import { Money } from "@/platform/money/money";
import { ownerPayoutDraftSchema } from "../domain/owner-payout";
import { isExpenseFundingAccount, expenseFundingWalletResource } from "../domain/expense";
import { OwnerPayoutRepository, type OwnerPayoutRecord } from "../infrastructure/owner-payout-repository";
import { OwnerLedgerRepository } from "../infrastructure/owner-ledger-repository";
import { ExpenseRepository } from "../infrastructure/expense-repository";
import { FinanceRepository } from "../infrastructure/finance-repository";
import { recheckFinanceAuthorization, type FinanceActorContext } from "./finance-access";

type Deps = { db?: TenantTransactionRunner; requestId?: string };
export class OwnerPayoutAccessError extends Error {}
export class OwnerPayoutConflictError extends Error {}
export class OwnerPayoutConfigurationError extends Error {}

function payoutResource(ctx: FinanceActorContext, row: Pick<OwnerPayoutRecord,"id"|"ownerId"|"propertyId"|"amount"|"state"|"createdBy">,
  property: { cityId: string | null; regionId: string | null }): Resource {
  return { type: "financial_transaction", organizationId: ctx.organizationId, id: row.id, financialRecordId: row.id,
    ownerId: row.ownerId, propertyId: row.propertyId, amount: row.amount.toString(), status: row.state,
    assignedUserAccountId: row.createdBy, city: property.cityId, region: property.regionId, dataClass: "financial" };
}

export async function createOwnerPayout(ctx: FinanceActorContext, raw: unknown, deps: Deps = {}) {
  const input = ownerPayoutDraftSchema.parse(raw);
  return withTenant(deps.db ?? prisma, ctx.organizationId, async tx => {
    const repository = new OwnerPayoutRepository(tx, ctx.organizationId);
    await repository.lockKey(input.idempotencyKey);
    const finance = new FinanceRepository(tx, ctx.organizationId), now = await finance.clock();
    const property = await new ExpenseRepository(tx, ctx.organizationId).property(input.propertyId);
    if (!property) throw new OwnerPayoutAccessError();
    const target: Resource = { type: "financial_transaction", organizationId: ctx.organizationId, propertyId: property.id, ownerId: input.ownerId,
      amount: input.amount, status: "DRAFT", assignedUserAccountId: ctx.actorId, city: property.cityId, region: property.regionId, dataClass: "financial" };
    await recheckFinanceAuthorization(ctx, tx, now, [{ action: "view", resource: target }, { action: "create", resource: target }], new OwnerPayoutAccessError());
    const existing = await repository.byKey(input.idempotencyKey);
    if (existing) {
      await recheckFinanceAuthorization(ctx, tx, now, [{ action: "view", resource: payoutResource(ctx, existing, existing.property) }], new OwnerPayoutAccessError());
      const audit = await repository.audit(existing.id, "finance.owner_payout.created");
      const saved = z.object({ request: ownerPayoutDraftSchema }).safeParse(audit?.after);
      if (!audit || audit.actorId !== ctx.actorId || !saved.success || JSON.stringify(saved.data.request) !== JSON.stringify(input)) throw new OwnerPayoutConflictError();
      return { id: existing.id, idempotent: true };
    }
    const ledger = new OwnerLedgerRepository(tx, ctx.organizationId), owner = await ledger.owner(input.ownerId);
    if (!owner || !owner.propertyOwners.some(row => row.property.id === property.id) && !await ledger.hasPropertyHistory(owner.id, property.id)) throw new OwnerPayoutAccessError();
    const method = await repository.method(input.payoutMethodId), funding = await finance.findLedgerAccountById(input.fundingAccountId);
    const currency = await new ExpenseRepository(tx, ctx.organizationId).currency(input.currency);
    if (!currency || currency.minorUnit > 2 || Money.of(input.amount,input.currency).amount.decimalPlaces() > currency.minorUnit ||
      !method || method.ownerId !== owner.id || method.currency !== input.currency || method.status !== "ACTIVE" || method.archivedAt || !funding || !isExpenseFundingAccount(funding)) throw new OwnerPayoutConfigurationError();
    const source: Resource = { type: "financial_transaction", organizationId: ctx.organizationId, id: funding.id, financialRecordId: funding.id, dataClass: "financial" };
    const wallet = expenseFundingWalletResource(ctx.organizationId, funding, input.amount, now);
    await recheckFinanceAuthorization(ctx, tx, now, [{ action: "view", resource: source }, ...(wallet ? [{ action: "view" as const, resource: wallet }] : [])], new OwnerPayoutAccessError());
    if (input.reservationId && (await new ExpenseRepository(tx, ctx.organizationId).reservation(input.reservationId))?.propertyId !== property.id) throw new OwnerPayoutAccessError();
    const row = await repository.create(input, ctx.actorId);
    await writeAuditEvent(tx, { organizationId: ctx.organizationId, actorId: ctx.actorId, action: "finance.owner_payout.created", resourceType: "owner_payout", resourceId: row.id,
      propertyScopeId: property.id, after: { request: input, payoutId: row.id, state: row.state, version: row.version }, reason: input.reason, requestId: deps.requestId ?? crypto.randomUUID(), occurredAt: now });
    return { id: row.id, idempotent: false };
  });
}

export async function getOwnerPayout(ctx: FinanceActorContext, rawId: string, deps: Deps = {}) {
  const id = z.uuid().parse(rawId);
  return withTenant(deps.db ?? prisma, ctx.organizationId, async tx => {
    const repository = new OwnerPayoutRepository(tx, ctx.organizationId), row = await repository.find(id);
    if (!row) throw new OwnerPayoutAccessError();
    const now = await new FinanceRepository(tx, ctx.organizationId).clock(), target = payoutResource(ctx, row, row.property);
    await recheckFinanceAuthorization(ctx, tx, now, [{ action: "view", resource: target }], new OwnerPayoutAccessError());
    const current = await authContextForAccountInTransaction(tx, ctx.organizationId, ctx.actorId);
    const data = { id: row.id, ownerName: row.owner.displayName, propertyName: row.property.name, state: row.state, version: row.version,
      amount: row.amount.toFixed(2), currency: row.currency, purpose: row.purpose, payoutMethodLabel: row.payoutMethod.label,
      eligibleAt: row.eligibleAt?.toISOString() ?? null, scheduledFor: row.scheduledFor?.toISOString() ?? null, paidAt: row.paidAt?.toISOString() ?? null,
      paymentReference: row.paymentReference, canEdit: row.state === "DRAFT" && [ctx.authContext,current].every(authority => authorize(authority,"edit",target,now)) };
    const result = present({ ...ctx.authContext, visibleDataClasses: new Set() }, "view", { ...target, data }, {}) as typeof data;
    await writeAuditEvent(tx, { organizationId: ctx.organizationId, actorId: ctx.actorId, action: "finance.owner_payout.viewed", resourceType: "owner_payout", resourceId: row.id,
      propertyScopeId: row.propertyId, after: { payoutId: row.id, state: row.state }, reason: "Viewed the authorized owner payout", requestId: deps.requestId ?? crypto.randomUUID(), occurredAt: now });
    return result;
  });
}
