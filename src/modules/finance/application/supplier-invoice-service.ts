import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/platform/db/client";
import { withTenant, type TenantTransactionRunner } from "@/platform/db/tenant";
import { authorize, type Action, type AuthContext } from "@/platform/authz/authorize";
import { authorizeOrganizationSource } from "@/platform/authz/organization-authority";
import { present, catalogFieldPolicy } from "@/platform/authz/present";
import { writeAuditEvent } from "@/platform/audit/audit-writer";
import { Money } from "@/platform/money/money";
import { FinanceRepository } from "../infrastructure/finance-repository";
import { SupplierRepository } from "../infrastructure/supplier-repository";
import { ExpenseRepository } from "../infrastructure/expense-repository";
import { SupplierInvoiceRepository, type SupplierInvoiceRecord } from "../infrastructure/supplier-invoice-repository";
import { createSupplierInvoiceInput, updateSupplierInvoiceInput, archiveSupplierInvoiceInput, supplierInvoiceFilters, supplierInvoiceHistoryInput, canonicalSupplierInvoiceFields, type SupplierInvoiceFields } from "../domain/supplier-invoice";
import type { FinanceActorContext } from "./finance-access";
import { SupplierInvoiceAccessError, SupplierInvoiceConflictError, assertSupplierInvoiceAuthority as authority, supplierInvoiceOrganizationResource as resource } from "./supplier-invoice-access";
export { SupplierInvoiceAccessError, SupplierInvoiceConflictError } from "./supplier-invoice-access";

type Deps = { db?: TenantTransactionRunner; requestId?: string };
export async function assertSupplierInvoiceAccess(ctx: FinanceActorContext, action: Action = "view", deps: Deps = {}) {
  await withTenant(deps.db ?? prisma, ctx.organizationId, async tx => authority(ctx, tx, action, await new FinanceRepository(tx, ctx.organizationId).clock()));
}
export async function getSupplierInvoiceEditor(ctx: FinanceActorContext, mode: "create" | "edit", supplierId?: string, deps: Deps = {}) {
  if (supplierId) z.uuid().parse(supplierId);
  return withTenant(deps.db ?? prisma, ctx.organizationId, async tx => {
    await authority(ctx, tx, mode, await new FinanceRepository(tx, ctx.organizationId).clock());
    const sources = await new ExpenseRepository(tx, ctx.organizationId).editorSources();
    const supplier = supplierId ? await new SupplierRepository(tx, ctx.organizationId).find(supplierId) : null;
    if (supplierId && (!supplier || supplier.archivedAt)) throw new SupplierInvoiceAccessError();
    return { ...sources, supplier: supplier ? { id: supplier.id, label: supplier.displayName, description: supplier.category } : null };
  });
}
const choiceInput = z.object({ kind: z.enum(["supplier", "property", "reservation"]), mode: z.enum(["create", "edit"]), query: z.string().trim().max(160).default(""), after: z.uuid().optional(), propertyId: z.uuid().optional() }).strict();
export async function getSupplierInvoiceChoices(ctx: FinanceActorContext, raw: unknown, deps: Deps = {}) {
  const input = choiceInput.parse(raw);
  return withTenant(deps.db ?? prisma, ctx.organizationId, async tx => {
    const now = await new FinanceRepository(tx, ctx.organizationId).clock(), current = await authority(ctx, tx, input.mode, now), repository = new SupplierInvoiceRepository(tx, ctx.organizationId);
    let options: Array<{ id: string; label: string; description: string }>;
    if (input.kind === "supplier") options = (await repository.supplierChoices(input.query)).map(row => ({ id: row.id, label: row.displayName, description: row.category }));
    else if (input.kind === "property") options = (await repository.propertyChoices(input.query)).filter(row => [ctx.authContext, current].every(auth => authorize(auth, "view", { type: "property", organizationId: ctx.organizationId, propertyId: row.id, city: row.cityId, region: row.regionId }, now))).map(row => ({ id: row.id, label: row.name, description: row.city + ", " + row.addressLine1 }));
    else {
      if (!input.propertyId) throw new SupplierInvoiceAccessError();
      const property = (await repository.properties([input.propertyId]))[0];
      if (!property || ![ctx.authContext, current].every(auth => authorize(auth, "view", { type: "property", organizationId: ctx.organizationId, propertyId: property.id, city: property.cityId, region: property.regionId }, now))) throw new SupplierInvoiceAccessError();
      options = (await repository.reservationChoices(property.id, input.query)).filter(row => [ctx.authContext, current].every(auth => authorize(auth, "view", { type: "reservation", organizationId: ctx.organizationId, propertyId: row.propertyId, id: row.id, reservationId: row.id, status: row.status, assignedUserAccountId: row.createdBy }, now))).map(row => ({ id: row.id, label: row.reference, description: "" }));
    }
    const boundary = input.after ? options.findIndex(row => row.id === input.after) : -1;
    if (input.after && boundary < 0) throw new SupplierInvoiceAccessError();
    const page = options.slice(boundary + 1, boundary + 52);
    return { options: page.slice(0, 50), next: page.length > 50 ? page[49].id : undefined };
  }, { isolationLevel: "RepeatableRead" });
}
async function validateSources(ctx: FinanceActorContext, current: AuthContext, fields: SupplierInvoiceFields, repository: SupplierInvoiceRepository, now: Date) {
  const currency = await repository.currency(fields.currency);
  if (!currency || currency.minorUnit > 2 || fields.lines.some(line => Money.of(line.amount, fields.currency).amount.decimalPlaces() > currency.minorUnit)) throw new z.ZodError([{ code: "custom", path: ["currency"], message: "Unsupported invoice currency or precision" }]);
  const propertyIds = [...new Set(fields.lines.flatMap(line => line.propertyId ? [line.propertyId] : []))];
  const reservationIds = [...new Set(fields.lines.flatMap(line => line.reservationId ? [line.reservationId] : []))];
  const [properties, reservations] = await Promise.all([repository.properties(propertyIds), repository.reservations(reservationIds)]);
  if (properties.length !== propertyIds.length || reservations.length !== reservationIds.length) throw new SupplierInvoiceAccessError();
  for (const property of properties) if (![ctx.authContext, current].every(auth => authorize(auth, "view", { type: "property", organizationId: ctx.organizationId, propertyId: property.id, city: property.cityId, region: property.regionId }, now))) throw new SupplierInvoiceAccessError();
  for (const line of fields.lines) if (line.reservationId) {
    const reservation = reservations.find(row => row.id === line.reservationId);
    const property = properties.find(row => row.id === line.propertyId);
    if (!reservation || reservation.propertyId !== line.propertyId || ![ctx.authContext, current].every(auth => authorize(auth, "view", { type: "reservation", organizationId: ctx.organizationId, propertyId: reservation.propertyId, reservationId: reservation.id, id: reservation.id, status: reservation.status, assignedUserAccountId: reservation.createdBy, city: property?.cityId, region: property?.regionId }, now))) throw new SupplierInvoiceAccessError();
  }
}
async function conflicts<T>(work: () => Promise<T>): Promise<T> {
  try { return await work(); } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") throw new SupplierInvoiceConflictError();
    throw error;
  }
}
function can(ctx: FinanceActorContext, current: AuthContext, action: Action, now: Date) { return [ctx.authContext, current].every(auth => authorizeOrganizationSource(auth, action, resource(ctx.organizationId), now)); }
function summary(ctx: FinanceActorContext, row: SupplierInvoiceRecord, now: Date) {
  const current = row.currentRevision; if (!current) throw new SupplierInvoiceConflictError();
  const data = { id: row.id, supplierId: row.supplierId, supplierName: row.supplier.displayName, reference: row.reference, invoiceNumber: row.invoiceNumber,
    version: row.version, state: row.state, archived: row.archivedAt !== null, amount: current.amount.toFixed(2), currency: current.currency,
    purpose: current.purpose, issuedOn: current.issuedOn.toISOString().slice(0, 10), dueOn: current.dueOn?.toISOString().slice(0, 10) ?? null };
  return present({ ...ctx.authContext, visibleDataClasses: new Set() }, "view", { ...resource(ctx.organizationId), data }, catalogFieldPolicy<typeof data>("supplier_invoice"), now) as typeof data;
}
export async function listSupplierInvoices(ctx: FinanceActorContext, raw: unknown = {}, deps: Deps = {}) {
  const input = supplierInvoiceFilters.parse(raw);
  return withTenant(deps.db ?? prisma, ctx.organizationId, async tx => {
    const now = await new FinanceRepository(tx, ctx.organizationId).clock(), current = await authority(ctx, tx, "view", now);
    const rows = await new SupplierInvoiceRepository(tx, ctx.organizationId).list(input);
    return { invoices: rows.slice(0, 50).map(row => summary(ctx, row, now)), next: rows.length > 50 ? rows[49].id : undefined, canCreate: can(ctx, current, "create", now) };
  }, { isolationLevel: "RepeatableRead" });
}
export async function getSupplierInvoice(ctx: FinanceActorContext, id: string, raw: unknown = {}, deps: Deps = {}) {
  id = z.uuid().parse(id); const input = supplierInvoiceHistoryInput.parse(raw);
  return withTenant(deps.db ?? prisma, ctx.organizationId, async tx => {
    const now = await new FinanceRepository(tx, ctx.organizationId).clock(), current = await authority(ctx, tx, "view", now), repository = new SupplierInvoiceRepository(tx, ctx.organizationId);
    const row = await repository.find(id); if (!row?.currentRevision) throw new SupplierInvoiceAccessError();
    const selected = input.revisionId ? await repository.revision(id, input.revisionId) : row.currentRevision; if (!selected) throw new SupplierInvoiceAccessError();
    const history = await repository.history(id, input.beforeVersion);
    const data = { ...summary(ctx, row, now), currentRevisionId: row.currentRevision.id, revisionId: selected.id, revisionVersion: selected.version,
      invoiceNumber: selected.invoiceNumber, amount: selected.amount.toFixed(2), currency: selected.currency, purpose: selected.purpose,
      issuedOn: selected.issuedOn.toISOString().slice(0, 10), dueOn: selected.dueOn?.toISOString().slice(0, 10) ?? null,
      approvalId: row.currentSubmission?.approval?.id ?? null,
      canSubmit: row.state === "DRAFT" && !row.archivedAt && !row.supplier.archivedAt && can(ctx, current, "edit", now),
      lines: selected.lines.map(line => ({ id: line.id, propertyId: line.propertyId, reservationId: line.reservationId, propertyName: line.property && [ctx.authContext, current].every(auth => authorize(auth, "view", { type: "property", organizationId: ctx.organizationId, propertyId: line.property!.id, city: line.property!.cityId, region: line.property!.regionId }, now)) ? line.property.name : null,
        reservationReference: line.reservation && [ctx.authContext, current].every(auth => authorize(auth, "view", { type: "reservation", organizationId: ctx.organizationId, propertyId: line.propertyId, id: line.reservationId ?? undefined, reservationId: line.reservationId, status: line.reservation!.status, assignedUserAccountId: line.reservation!.createdBy, city: line.property?.cityId, region: line.property?.regionId }, now)) ? line.reservation.reference : null,
        category: line.category, costCenter: line.costCenter, amount: line.amount.toFixed(2) })),
      history: history.slice(0, 50).map(revision => ({ id: revision.id, version: revision.version, invoiceNumber: revision.invoiceNumber, amount: revision.amount.toFixed(2), currency: revision.currency,
        createdAt: revision.createdAt.toISOString(), createdBy: revision.createdBy, reason: revision.reason })),
      historyNext: history.length > 50 ? history[49].version : undefined, canEdit: ["DRAFT", "REJECTED"].includes(row.state) && !row.archivedAt && !row.supplier.archivedAt && can(ctx, current, "edit", now),
      canArchive: row.state === "DRAFT" && can(ctx, current, "edit", now) };
    return present({ ...ctx.authContext, visibleDataClasses: new Set() }, "view", { ...resource(ctx.organizationId), data }, catalogFieldPolicy<typeof data>("supplier_invoice"), now) as typeof data;
  }, { isolationLevel: "RepeatableRead" });
}
export async function createSupplierInvoice(ctx: FinanceActorContext, raw: unknown, deps: Deps = {}) {
  const { supplierId, idempotencyKey, reason, ...rest } = createSupplierInvoiceInput.parse(raw), fields = canonicalSupplierInvoiceFields(rest);
  const fingerprint = createHash("sha256").update(JSON.stringify({ supplierId, fields, actorId: ctx.actorId, reason })).digest("hex");
  return conflicts(() => withTenant(deps.db ?? prisma, ctx.organizationId, async tx => {
    const repository = new SupplierInvoiceRepository(tx, ctx.organizationId), finance = new FinanceRepository(tx, ctx.organizationId);
    await authority(ctx, tx, "create", await finance.clock()); await repository.lock("create:" + idempotencyKey);
    const suppliers = new SupplierRepository(tx, ctx.organizationId); await suppliers.lock(supplierId);
    let now = await finance.clock(), current = await authority(ctx, tx, "create", now);
    const prior = await repository.byKey(idempotencyKey);
    if (prior) { if (prior.requestFingerprint !== fingerprint) throw new SupplierInvoiceConflictError(); return { id: prior.id, idempotent: true }; }
    const supplier = await suppliers.find(supplierId); if (!supplier || supplier.archivedAt) throw new SupplierInvoiceAccessError();
    await validateSources(ctx, current, fields, repository, now);
    const ids = await repository.identities(), invoice = await repository.create({ ...ids, supplierId, invoiceNumber: fields.invoiceNumber, idempotencyKey, requestFingerprint: fingerprint, actorId: ctx.actorId });
    await repository.createRevision({ id: ids.revisionId, invoiceId: invoice.id, version: 0, fields, actorId: ctx.actorId, reason });
    now = await finance.clock(); current = await authority(ctx, tx, "create", now); await validateSources(ctx, current, fields, repository, now);
    await writeAuditEvent(tx, { organizationId: ctx.organizationId, actorId: ctx.actorId, action: "finance.supplier_invoice.draft_created", resourceType: "supplier_invoice", resourceId: invoice.id,
      after: { version: 0, revisionId: ids.revisionId, supplierId, reference: invoice.reference }, reason, requestId: deps.requestId ?? crypto.randomUUID(), occurredAt: now });
    return { id: invoice.id, idempotent: false };
  }));
}
export async function updateSupplierInvoice(ctx: FinanceActorContext, raw: unknown, deps: Deps = {}) {
  const { id, expectedVersion, reason, ...rest } = updateSupplierInvoiceInput.parse(raw), fields = canonicalSupplierInvoiceFields(rest);
  return conflicts(() => withTenant(deps.db ?? prisma, ctx.organizationId, async tx => {
    const repository = new SupplierInvoiceRepository(tx, ctx.organizationId), finance = new FinanceRepository(tx, ctx.organizationId);
    await repository.lock(id); const row = await repository.find(id);
    let now = await finance.clock(); await authority(ctx, tx, "edit", now);
    if (!row || row.archivedAt || row.supplier.archivedAt || !["DRAFT", "REJECTED"].includes(row.state)) throw new SupplierInvoiceAccessError();
    if (row.version !== expectedVersion) throw new SupplierInvoiceConflictError();
    const suppliers = new SupplierRepository(tx, ctx.organizationId); await suppliers.lock(row.supplierId);
    const supplier = await suppliers.find(row.supplierId); if (!supplier || supplier.archivedAt) throw new SupplierInvoiceAccessError();
    now = await finance.clock(); let current = await authority(ctx, tx, "edit", now);
    await validateSources(ctx, current, fields, repository, now);
    const ids = await repository.identities();
    await repository.createRevision({ id: ids.revisionId, invoiceId: id, version: expectedVersion + 1, fields, actorId: ctx.actorId, reason });
    if ((await repository.pointToRevision({ id, expectedVersion, revisionId: ids.revisionId, invoiceNumber: fields.invoiceNumber, actorId: ctx.actorId })).count !== 1) throw new SupplierInvoiceConflictError();
    now = await finance.clock(); current = await authority(ctx, tx, "edit", now); await validateSources(ctx, current, fields, repository, now);
    await writeAuditEvent(tx, { organizationId: ctx.organizationId, actorId: ctx.actorId, action: "finance.supplier_invoice.draft_updated", resourceType: "supplier_invoice", resourceId: id,
      before: { version: row.version, revisionId: row.currentRevisionId }, after: { version: row.version + 1, revisionId: ids.revisionId }, reason, requestId: deps.requestId ?? crypto.randomUUID(), occurredAt: now });
    return { id, version: row.version + 1 };
  }));
}
export async function setSupplierInvoiceArchived(ctx: FinanceActorContext, raw: unknown, deps: Deps = {}) {
  const input = archiveSupplierInvoiceInput.parse(raw);
  return withTenant(deps.db ?? prisma, ctx.organizationId, async tx => {
    const repository = new SupplierInvoiceRepository(tx, ctx.organizationId), finance = new FinanceRepository(tx, ctx.organizationId); await repository.lock(input.id);
    const row = await repository.find(input.id), now = await finance.clock(); await authority(ctx, tx, "edit", now);
    if (!row || row.state !== "DRAFT") throw new SupplierInvoiceAccessError();
    if (row.version !== input.expectedVersion || Boolean(row.archivedAt) === input.archived) throw new SupplierInvoiceConflictError();
    if ((await repository.archive(row.id, row.version, input.archived ? now : null, ctx.actorId)).count !== 1) throw new SupplierInvoiceConflictError();
    const at = await finance.clock(); await authority(ctx, tx, "edit", at);
    await writeAuditEvent(tx, { organizationId: ctx.organizationId, actorId: ctx.actorId, action: input.archived ? "finance.supplier_invoice.draft_archived" : "finance.supplier_invoice.draft_restored", resourceType: "supplier_invoice", resourceId: row.id,
      before: { version: row.version, archived: Boolean(row.archivedAt) }, after: { version: row.version + 1, revisionId: row.currentRevisionId, archived: input.archived }, reason: input.reason, requestId: deps.requestId ?? crypto.randomUUID(), occurredAt: at });
    return { id: row.id, version: row.version + 1 };
  });
}
