import { z } from "zod";
import { authorize, type Resource } from "@/platform/authz/authorize";
import { authContextForAccountInTransaction } from "@/platform/authz/account-context";
import { writeAuditEvent } from "@/platform/audit/audit-writer";
import { prisma } from "@/platform/db/client";
import { withTenant, type TenantTransaction, type TenantTransactionRunner } from "@/platform/db/tenant";
import type { FinanceActorContext } from "./finance-access";
import { transactionGroupEntrySchema, transactionGroupFilters, transactionGroupSchema } from "../domain/transaction-group";
import { TransactionGroupRepository } from "../infrastructure/transaction-group-repository";

type Deps = { db?: TenantTransactionRunner; requestId?: string };
export class TransactionGroupAccessError extends Error {}
export class TransactionGroupConflictError extends Error {}
const detailFilters = z.object({ query: z.string().trim().max(120).optional(), membersAfter: z.uuid().optional(),
  historyAfter: z.uuid().optional(), candidatesAfter: z.uuid().optional() }).strict();
async function access(ctx: FinanceActorContext, tx: TenantTransaction, configure = false) {
  if (ctx.organizationId !== ctx.authContext.organizationId || ctx.actorId !== ctx.authContext.userAccountId) throw new TransactionGroupAccessError();
  const repository = new TransactionGroupRepository(tx, ctx.organizationId), now = await repository.clock();
  const current = await authContextForAccountInTransaction(tx, ctx.organizationId, ctx.actorId);
  const resource: Resource = { type: "financial_transaction", organizationId: ctx.organizationId, dataClass: "financial" };
  const canConfigure = authorize(current, "configure", resource, now);
  if (!authorize(current, "view", resource, now) || (configure && !canConfigure)) throw new TransactionGroupAccessError();
  return { repository, now, canConfigure };
}
const page = <T extends { id: string }>(rows: T[]) => ({ rows: rows.slice(0, 50), next: rows.length > 50 ? rows[49].id : undefined });

export async function assertTransactionGroupViewer(ctx: FinanceActorContext, deps: Deps = {}): Promise<void> {
  await withTenant(deps.db ?? prisma, ctx.organizationId, async tx => { await access(ctx, tx); });
}

export async function listTransactionGroups(ctx: FinanceActorContext, raw: unknown = {}, deps: Deps = {}) {
  const input = transactionGroupFilters.parse(raw);
  return withTenant(deps.db ?? prisma, ctx.organizationId, async tx => {
    const { repository, canConfigure } = await access(ctx, tx);
    return { ...page(await repository.list(input)), canConfigure };
  });
}
export async function getTransactionGroup(ctx: FinanceActorContext, groupId: string, raw: unknown = {}, deps: Deps = {}) {
  const id = z.uuid().parse(groupId), input = detailFilters.parse(raw);
  return withTenant(deps.db ?? prisma, ctx.organizationId, async tx => {
    const { repository, canConfigure } = await access(ctx, tx), group = await repository.group(id);
    if (!group) throw new TransactionGroupAccessError();
    const [members, history, movements, candidates] = await Promise.all([repository.members(id, input.membersAfter), repository.history(id, input.historyAfter),
      repository.movements(id), canConfigure ? repository.candidates({ after: input.candidatesAfter, query: input.query }) : []]);
    return { group, members: page(members), history: page(history), movements, candidates: page(candidates), canConfigure };
  });
}
export async function createTransactionGroup(ctx: FinanceActorContext, raw: unknown, deps: Deps = {}) {
  const input = transactionGroupSchema.parse(raw);
  return withTenant(deps.db ?? prisma, ctx.organizationId, async tx => {
    const repository = new TransactionGroupRepository(tx, ctx.organizationId); await repository.lockRequest(input.idempotencyKey);
    const { now } = await access(ctx, tx, true), existing = await repository.groupByKey(input.idempotencyKey);
    if (existing) {
      if (existing.name !== input.name || existing.reason !== input.reason || existing.createdBy !== ctx.actorId) throw new TransactionGroupConflictError();
      return { id: existing.id };
    }
    const group = await repository.createGroup({ ...input, createdBy: ctx.actorId });
    await writeAuditEvent(tx, { organizationId: ctx.organizationId, actorId: ctx.actorId, action: "finance.group.created",
      resourceType: "transaction_group", resourceId: group.id, after: { name: group.name }, reason: input.reason,
      requestId: deps.requestId ?? crypto.randomUUID(), occurredAt: now });
    return { id: group.id };
  });
}
export async function changeTransactionGroupMembership(ctx: FinanceActorContext, raw: unknown, deps: Deps = {}) {
  const input = transactionGroupEntrySchema.parse(raw);
  return withTenant(deps.db ?? prisma, ctx.organizationId, async tx => {
    const repository = new TransactionGroupRepository(tx, ctx.organizationId); await repository.lockRequest(input.idempotencyKey); await repository.lockTransaction(input.transactionId);
    const { now } = await access(ctx, tx, true);
    if (!await repository.group(input.groupId) || !await repository.transaction(input.transactionId)) throw new TransactionGroupAccessError();
    const existing = await repository.entryByKey(input.idempotencyKey);
    if (existing) {
      if (existing.groupId !== input.groupId || existing.transactionId !== input.transactionId || existing.previousEntryId !== input.previousEntryId ||
        existing.action !== input.action || existing.reason !== input.reason || existing.createdBy !== ctx.actorId) throw new TransactionGroupConflictError();
      return { id: existing.id };
    }
    const previous = await repository.currentEntry(input.transactionId);
    if ((previous?.id ?? null) !== input.previousEntryId || (input.action === "ATTACH" ? previous?.action === "ATTACH" :
      previous?.action !== "ATTACH" || previous.groupId !== input.groupId)) throw new TransactionGroupConflictError();
    const entry = await repository.createEntry({ ...input, createdBy: ctx.actorId });
    await writeAuditEvent(tx, { organizationId: ctx.organizationId, actorId: ctx.actorId,
      action: input.action === "ATTACH" ? "finance.group.attached" : "finance.group.detached", resourceType: "transaction_group", resourceId: input.groupId,
      after: { entryId: entry.id, transactionId: input.transactionId, previousEntryId: input.previousEntryId, action: input.action }, reason: input.reason,
      requestId: deps.requestId ?? crypto.randomUUID(), occurredAt: now });
    return { id: entry.id };
  });
}
