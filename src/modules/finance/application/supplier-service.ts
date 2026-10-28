import { createHash } from "node:crypto";
import type { Supplier } from "@prisma/client";
import { prisma } from "@/platform/db/client";
import { withTenant, type TenantTransaction, type TenantTransactionRunner } from "@/platform/db/tenant";
import { authContextForAccountInTransaction } from "@/platform/authz/account-context";
import { authorizeOrganizationSource } from "@/platform/authz/organization-authority";
import type { Action } from "@/platform/authz/authorize";
import { present, catalogFieldPolicy } from "@/platform/authz/present";
import { writeAuditEvent } from "@/platform/audit/audit-writer";
import { createSupplierInput, updateSupplierInput, archiveSupplierInput, supplierFields, supplierFilters } from "../domain/supplier";
import { SupplierRepository } from "../infrastructure/supplier-repository";
import { FinanceRepository } from "../infrastructure/finance-repository";
import type { FinanceActorContext } from "./finance-access";

type Deps = { db?: TenantTransactionRunner; requestId?: string };
export class SupplierAccessError extends Error {}
export class SupplierConflictError extends Error {}
const resource = (organizationId: string) => ({ type: "supplier", organizationId, dataClass: "personal" as const });
async function authority(ctx: FinanceActorContext, tx: TenantTransaction, action: Action, now: Date) {
  if (ctx.organizationId !== ctx.authContext.organizationId || ctx.actorId !== ctx.authContext.userAccountId) throw new SupplierAccessError();
  const current = await authContextForAccountInTransaction(tx, ctx.organizationId, ctx.actorId);
  if (![ctx.authContext, current].every(auth => ["view" as const, action].every(verb => authorizeOrganizationSource(auth, verb, resource(ctx.organizationId), now)))) throw new SupplierAccessError();
  return current;
}
export async function assertSupplierAccess(ctx: FinanceActorContext, action: Action = "view", deps: Deps = {}) {
  await withTenant(deps.db ?? prisma, ctx.organizationId, async tx => authority(ctx, tx, action, await new FinanceRepository(tx, ctx.organizationId).clock()));
}
const facts = (row: Supplier) => ({ id: row.id, reference: row.reference, version: row.version, displayName: row.displayName,
  category: row.category, email: row.email, phone: row.phone, address: row.address, archived: row.archivedAt !== null, archivedAt: row.archivedAt?.toISOString() ?? null });
function dto(ctx: FinanceActorContext, row: Supplier, now: Date) {
  const data = { id: row.id, reference: row.reference, version: row.version, ...supplierFields.strip().parse(row), archived: row.archivedAt !== null };
  return present({ ...ctx.authContext, visibleDataClasses: new Set() }, "view", { ...resource(ctx.organizationId), data }, catalogFieldPolicy<typeof data>("supplier"), now) as typeof data;
}
export async function listSuppliers(ctx: FinanceActorContext, raw: unknown = {}, deps: Deps = {}) {
  const input = supplierFilters.parse(raw);
  return withTenant(deps.db ?? prisma, ctx.organizationId, async tx => {
    const now = await new FinanceRepository(tx, ctx.organizationId).clock(), current = await authority(ctx, tx, "view", now);
    const rows = await new SupplierRepository(tx, ctx.organizationId).list(input);
    return { suppliers: rows.slice(0, 50).map(row => dto(ctx, row, now)), next: rows.length > 50 ? rows[49].id : undefined,
      canCreate: [ctx.authContext, current].every(auth => authorizeOrganizationSource(auth, "create", resource(ctx.organizationId), now)) };
  }, { isolationLevel: "RepeatableRead" });
}
export async function getSupplier(ctx: FinanceActorContext, id: string, deps: Deps = {}) {
  const input = archiveSupplierInput.shape.id.parse(id);
  return withTenant(deps.db ?? prisma, ctx.organizationId, async tx => {
    const now = await new FinanceRepository(tx, ctx.organizationId).clock(), current = await authority(ctx, tx, "view", now);
    const row = await new SupplierRepository(tx, ctx.organizationId).find(input); if (!row) throw new SupplierAccessError();
    return { ...dto(ctx, row, now), canEdit: [ctx.authContext, current].every(auth => authorizeOrganizationSource(auth, "edit", resource(ctx.organizationId), now)) };
  });
}
export async function createSupplier(ctx: FinanceActorContext, raw: unknown, deps: Deps = {}) {
  const input = createSupplierInput.parse(raw), fields = supplierFields.strip().parse(input);
  const fingerprint = createHash("sha256").update(JSON.stringify({ fields, actorId: ctx.actorId, reason: input.reason })).digest("hex");
  return withTenant(deps.db ?? prisma, ctx.organizationId, async tx => {
    const repository = new SupplierRepository(tx, ctx.organizationId); await repository.lock(input.idempotencyKey);
    const now = await new FinanceRepository(tx, ctx.organizationId).clock(); await authority(ctx, tx, "create", now);
    const existing = await repository.request(input.idempotencyKey);
    if (existing) { if (existing.requestFingerprint !== fingerprint) throw new SupplierConflictError(); return { id: existing.id, idempotent: true }; }
    const row = await repository.create(fields, { idempotencyKey: input.idempotencyKey, requestFingerprint: fingerprint, actorId: ctx.actorId });
    const committedAt = await new FinanceRepository(tx, ctx.organizationId).clock(); await authority(ctx, tx, "create", committedAt);
    await writeAuditEvent(tx, { organizationId: ctx.organizationId, actorId: ctx.actorId, action: "finance.supplier.created", resourceType: "supplier", resourceId: row.id,
      after: facts(row), reason: input.reason, requestId: deps.requestId ?? crypto.randomUUID(), occurredAt: committedAt });
    return { id: row.id, idempotent: false };
  });
}
export async function updateSupplier(ctx: FinanceActorContext, raw: unknown, deps: Deps = {}) {
  const input = updateSupplierInput.parse(raw);
  return changeSupplier(ctx, input, "updated", async repository => repository.update(input.id, input.expectedVersion,
    supplierFields.strip().parse(input)), deps);
}
export async function setSupplierArchived(ctx: FinanceActorContext, raw: unknown, deps: Deps = {}) {
  const input = archiveSupplierInput.parse(raw);
  return changeSupplier(ctx, input, input.archived ? "archived" : "restored", (repository, now) => repository.archive(input.id, input.expectedVersion, input.archived ? now : null), deps);
}
async function changeSupplier(ctx: FinanceActorContext, input: { id: string; expectedVersion: number; reason: string }, operation: string,
  update: (repository: SupplierRepository, now: Date) => Promise<{ count: number }>, deps: Deps) {
  return withTenant(deps.db ?? prisma, ctx.organizationId, async tx => {
    const repository = new SupplierRepository(tx, ctx.organizationId); await repository.lock(input.id);
    const now = await new FinanceRepository(tx, ctx.organizationId).clock(); await authority(ctx, tx, "edit", now);
    const before = await repository.find(input.id); if (!before) throw new SupplierAccessError();
    if ((operation === "archived" && before.archivedAt !== null) || (operation === "restored" && before.archivedAt === null)) throw new SupplierConflictError();
    if (before.version !== input.expectedVersion || (await update(repository, now)).count !== 1) throw new SupplierConflictError();
    const after = await repository.find(input.id); if (!after) throw new SupplierAccessError();
    const committedAt = await new FinanceRepository(tx, ctx.organizationId).clock(); await authority(ctx, tx, "edit", committedAt);
    await writeAuditEvent(tx, { organizationId: ctx.organizationId, actorId: ctx.actorId, action: `finance.supplier.${operation}`, resourceType: "supplier", resourceId: before.id,
      before: facts(before), after: facts(after), reason: input.reason, requestId: deps.requestId ?? crypto.randomUUID(), occurredAt: committedAt });
    return { id: after.id, version: after.version };
  });
}
