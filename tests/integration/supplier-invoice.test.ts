import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { Prisma, PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { provisionIntegrationRole } from "./support/database-role";
import { withTenant } from "@/platform/db/tenant";
import { authContextForAccount } from "@/platform/authz/account-context";
import { ensureStandardIdentitySetup } from "@/modules/identity/application/identity-service";
import { createSupplier, setSupplierArchived } from "@/modules/finance/application/supplier-service";
import { SupplierRepository } from "@/modules/finance/infrastructure/supplier-repository";
import { supplierInvoiceFields } from "@/modules/finance/domain/supplier-invoice";
import { createSupplierInvoice, updateSupplierInvoice, getSupplierInvoice, listSupplierInvoices, setSupplierInvoiceArchived, getSupplierInvoiceChoices, SupplierInvoiceAccessError, SupplierInvoiceConflictError } from "@/modules/finance/application/supplier-invoice-service";
import { presentAuditHistoryRow } from "@/modules/audit/application/audit-service";

const url = process.env.TEST_DATABASE_URL;
let admin: PrismaClient, db: PrismaClient;
async function fixture() {
  const org = randomUUID(); await admin.organization.create({ data: { id: org, name: "Dedicated invoice source tenant" } });
  await ensureStandardIdentitySetup(org, { db });
  const source = await withTenant(db, org, async tx => {
    await tx.currency.upsert({ where: { code: "MAD" }, update: {}, create: { code: "MAD", name: "Dirham", minorUnit: 2 } });
    const person = await tx.person.create({ data: { organizationId: org, displayName: "Invoice source author" } });
    const account = await tx.userAccount.create({ data: { organizationId: org, personId: person.id } });
    const role = await tx.role.create({ data: { organizationId: org, key: `invoice_qa_${randomUUID()}`, name: "Invoice source author" } });
    for (const key of ["supplier:view", "supplier:create", "supplier:edit", "supplier_invoice:view", "supplier_invoice:create", "supplier_invoice:edit", "property:view", "reservation:view", "audit_log:view"]) {
      const permission = await tx.permission.findFirstOrThrow({ where: { organizationId: org, key } });
      await tx.rolePermission.create({ data: { organizationId: org, roleId: role.id, permissionId: permission.id } });
    }
    const assignment = await tx.roleAssignment.create({ data: { organizationId: org, userAccountId: account.id, personId: person.id, roleId: role.id, scopeType: "organization", validFrom: new Date("2000-01-01") } });
    const property = await tx.property.create({ data: { organizationId: org, name: "Invoice source villa", addressLine1: "Local acceptance", city: "Marrakech", propertyType: "VILLA", bedrooms: 1, bathrooms: 1, maxGuests: 2, amenities: [], photoUrls: [] } });
    return { account, assignment, property };
  });
  const ctx = { organizationId: org, actorId: source.account.id, personId: source.account.personId, authContext: await authContextForAccount(org, source.account.id, { db }) };
  const supplier = await createSupplier(ctx, { idempotencyKey: randomUUID(), displayName: "Actual invoice supplier", category: "Maintenance", reason: "Dedicated actual invoice supplier" }, { db });
  return { org, ...source, ctx, supplier };
}
const input = (supplierId: string) => ({ supplierId, invoiceNumber: `INV-${randomUUID()}`, issuedOn: "2026-10-28", currency: "MAD", purpose: "Dedicated actual supplier invoice", lines: [{ category: "maintenance", amount: "2400.00" }], idempotencyKey: randomUUID(), reason: "Dedicated supplier invoice acceptance" });
const update = (created: ReturnType<typeof input>, id: string, expectedVersion: number) => {
  return { ...supplierInvoiceFields.strip().parse(created), reason: created.reason, id, expectedVersion };
};

describe("immutable supplier invoice authoring on PostgreSQL", () => {
  beforeAll(async () => {
    if (!url || !["localhost", "127.0.0.1"].includes(new URL(url).hostname)) throw Error("Dedicated local PostgreSQL required");
    execFileSync(process.execPath, ["node_modules/prisma/build/index.js", "migrate", "deploy"], { env: { ...process.env, DATABASE_URL: url }, stdio: "pipe" });
    admin = new PrismaClient({ datasourceUrl: url }); await provisionIntegrationRole(admin, "alvillas_ops_tests");
    const scoped = new URL(url); scoped.username = "alvillas_ops_tests"; scoped.password = "alvillas_ops_tests"; db = new PrismaClient({ datasourceUrl: scoped.toString() });
  });
  afterAll(async () => { await db?.$disconnect(); await admin?.$disconnect(); });
  it("rejects an edit if its supplier is archived while the source lock blocks the command", async () => {
    const f = await fixture(), creation = input(f.supplier.id), invoice = await createSupplierInvoice(f.ctx, creation, { db });
    let release!: () => void, locked!: () => void, blocker = 0;
    const ready = new Promise<void>(resolve => locked = resolve), gate = new Promise<void>(resolve => release = resolve);
    const holder = withTenant(admin, f.org, async tx => {
      await new SupplierRepository(tx, f.org).lock(f.supplier.id);
      const [row] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`; blocker = row.pid;
      locked(); await gate;
      await setSupplierArchived(f.ctx, { id: f.supplier.id, expectedVersion: 0, archived: true, reason: "Supplier archived during invoice wait" }, { db: { $transaction: work => work(tx) } });
    });
    await ready;
    const editing = updateSupplierInvoice(f.ctx, { ...update(creation, invoice.id, 0), purpose: "Archived supplier edit must roll back" }, { db })
      .then(value => ({ ok: true as const, value }), error => ({ ok: false as const, error: error as unknown }));
    try {
      await vi.waitFor(async () => {
        const [row] = await admin.$queryRaw<Array<{ waiting: boolean }>>(Prisma.sql`SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND ${blocker}=ANY(pg_blocking_pids(pid))) AS waiting`);
        expect(row.waiting).toBe(true);
      }, { timeout: 10000 });
    } finally { release(); await holder; }
    const result = await editing; expect(result.ok).toBe(false); if (!result.ok) expect(result.error).toBeInstanceOf(SupplierInvoiceAccessError);
    expect(await withTenant(admin, f.org, tx => tx.supplierInvoiceRevision.count({ where: { organizationId: f.org } }))).toBe(1);
  });
  it("rolls back the new revision if stored authority is revoked during a real invoice row wait", async () => {
    const f = await fixture(), creation = input(f.supplier.id), invoice = await createSupplierInvoice(f.ctx, creation, { db });
    let release!: () => void, locked!: () => void, blocker = 0;
    const ready = new Promise<void>(resolve => locked = resolve), gate = new Promise<void>(resolve => release = resolve);
    const holder = withTenant(admin, f.org, async tx => {
      await tx.$queryRaw(Prisma.sql`SELECT id FROM supplier_invoice WHERE organization_id=${f.org}::uuid AND id=${invoice.id}::uuid FOR UPDATE`);
      const [row] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`; blocker = row.pid;
      locked(); await gate;
    });
    await ready;
    const editing = updateSupplierInvoice(f.ctx, { ...update(creation, invoice.id, 0), purpose: "Revoked invoice edit must roll back" }, { db })
      .then(value => ({ ok: true as const, value }), error => ({ ok: false as const, error: error as unknown }));
    try {
      await vi.waitFor(async () => {
        const [row] = await admin.$queryRaw<Array<{ waiting: boolean }>>(Prisma.sql`SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND ${blocker}=ANY(pg_blocking_pids(pid))) AS waiting`);
        expect(row.waiting).toBe(true);
      }, { timeout: 10000 });
      await withTenant(admin, f.org, tx => tx.roleAssignment.update({ where: { id: f.assignment.id }, data: { archivedAt: new Date() } }));
    } finally { release(); await holder; }
    const result = await editing; expect(result.ok).toBe(false); if (!result.ok) expect(result.error).toBeInstanceOf(SupplierInvoiceAccessError);
    await withTenant(admin, f.org, async tx => {
      expect(await tx.supplierInvoiceRevision.count({ where: { organizationId: f.org } })).toBe(1); expect(await tx.supplierInvoiceLine.count({ where: { organizationId: f.org } })).toBe(1);
      expect((await tx.supplierInvoice.findUniqueOrThrow({ where: { id: invoice.id } })).version).toBe(0);
      expect(await tx.auditLog.count({ where: { resourceId: invoice.id } })).toBe(1);
    });
  });
  it("creates one attributed invoice under concurrent retries and rejects changed intent and duplicate supplier invoice numbers", async () => {
    const f = await fixture(), creation = input(f.supplier.id);
    const rows = await Promise.all(Array.from({ length: 4 }, () => createSupplierInvoice(f.ctx, creation, { db })));
    expect(new Set(rows.map(row => row.id)).size).toBe(1);
    const invoice = await getSupplierInvoice(f.ctx, rows[0].id, {}, { db });
    expect(invoice).toMatchObject({ reference: "SINV-0001", version: 0, invoiceNumber: creation.invoiceNumber, amount: "2400.00", dueOn: null, lines: [{ amount: "2400.00" }] });
    await expect(createSupplierInvoice(f.ctx, { ...creation, lines: [{ category: "maintenance", amount: "2400.0" }] }, { db })).resolves.toMatchObject({ id: invoice.id, idempotent: true });
    await expect(createSupplierInvoice(f.ctx, { ...creation, purpose: "Changed actual invoice intent" }, { db })).rejects.toBeInstanceOf(SupplierInvoiceConflictError);
    await expect(createSupplierInvoice(f.ctx, { ...creation, idempotencyKey: randomUUID() }, { db })).rejects.toBeInstanceOf(SupplierInvoiceConflictError);
    await withTenant(db, f.org, async tx => {
      expect(await tx.supplierInvoice.count()).toBe(1); expect(await tx.supplierInvoiceRevision.count()).toBe(1); expect(await tx.supplierInvoiceLine.count()).toBe(1);
      expect(await tx.financialTransaction.count()).toBe(0); expect(await tx.auditLog.count({ where: { resourceId: invoice.id } })).toBe(1);
    });
  });
  it("honors the configured currency minor unit before saving an invoice source", async () => {
    const f = await fixture();
    await admin.currency.upsert({ where: { code: "JPY" }, update: {}, create: { code: "JPY", name: "Yen", minorUnit: 0 } });
    await expect(createSupplierInvoice(f.ctx, { ...input(f.supplier.id), currency: "JPY", lines: [{ category: "maintenance", amount: "10.01" }] }, { db })).rejects.toThrow(/currency|precision/iu);
    const invoice = await createSupplierInvoice(f.ctx, { ...input(f.supplier.id), currency: "JPY", lines: [{ category: "maintenance", amount: "10.00" }] }, { db });
    expect((await getSupplierInvoice(f.ctx, invoice.id, {}, { db })).amount).toBe("10.00");
    expect(await withTenant(db, f.org, tx => tx.supplierInvoice.count())).toBe(1);
  });
  it("retains 500 real property allocations with exact totals and no financial movement at the draft stage", async () => {
    const f = await fixture();
    const properties = Array.from({ length: 500 }, (_, index) => ({ id: randomUUID(), organizationId: f.org, name: `Invoice allocation villa ${index}`, addressLine1: "Local acceptance", city: "Marrakech", propertyType: "VILLA", bedrooms: 1, bathrooms: 1, maxGuests: 2, amenities: [], photoUrls: [] }));
    await withTenant(db, f.org, tx => tx.property.createMany({ data: properties }));
    const invoice = await createSupplierInvoice(f.ctx, { ...input(f.supplier.id), lines: properties.map(property => ({ propertyId: property.id, category: "maintenance", amount: "100.01" })) }, { db });
    const details = await getSupplierInvoice(f.ctx, invoice.id, {}, { db });
    expect(details.lines).toHaveLength(500); expect(details.amount).toBe("50005.00");
    expect(new Set(details.lines.map(line => line.propertyId)).size).toBe(500);
    let page = await getSupplierInvoiceChoices(f.ctx, { kind: "property", mode: "create", query: "Invoice allocation villa" }, { db });
    const found = [...page.options];
    while (page.next) { page = await getSupplierInvoiceChoices(f.ctx, { kind: "property", mode: "create", query: "Invoice allocation villa", after: page.next }, { db }); found.push(...page.options); }
    expect(new Set(found.map(row => row.id)).size).toBe(500);
    const noProperties = { ...f.ctx, authContext: { ...f.ctx.authContext, permissions: new Set([...f.ctx.authContext.permissions].filter(key => key !== "property:view")) } };
    expect((await getSupplierInvoiceChoices(noProperties, { kind: "property", mode: "create", query: "Invoice allocation villa" }, { db })).options).toEqual([]);
    expect((await getSupplierInvoice(noProperties, invoice.id, {}, { db })).lines.every(line => line.propertyName === null)).toBe(true);
    await expect(getSupplierInvoiceChoices(f.ctx, { kind: "property", mode: "create", query: "Invoice allocation villa", after: randomUUID() }, { db })).rejects.toBeInstanceOf(SupplierInvoiceAccessError);
    expect(await withTenant(db, f.org, tx => tx.financialTransaction.count())).toBe(0);
  });
  it("pages the full invoice directory and source revision history with stable exact boundaries", async () => {
    const f = await fixture(), created = input(f.supplier.id); let id = "";
    for (let index = 0; index < 53; index++) id = (await createSupplierInvoice(f.ctx, { ...created, idempotencyKey: randomUUID(), invoiceNumber: `INV-PAGE-${String(index).padStart(3, "0")}` }, { db })).id;
    const first = await listSupplierInvoices(f.ctx, {}, { db }), next = await listSupplierInvoices(f.ctx, { after: first.next }, { db });
    expect(first.invoices).toHaveLength(50); expect(next.invoices).toHaveLength(3); expect(next.next).toBeUndefined();
    expect(new Set([...first.invoices, ...next.invoices].map(row => row.id)).size).toBe(53);
    expect((await listSupplierInvoices(f.ctx, { query: "INV-PAGE-001" }, { db })).invoices).toHaveLength(1);
    for (let version = 0; version < 52; version++) await updateSupplierInvoice(f.ctx, { ...update(created, id, version), invoiceNumber: "INV-PAGE-052", purpose: `Versioned invoice ${version}` }, { db });
    const current = await getSupplierInvoice(f.ctx, id, {}, { db }), older = await getSupplierInvoice(f.ctx, id, { beforeVersion: current.historyNext }, { db });
    expect(current.history).toHaveLength(50); expect(older.history).toHaveLength(3);
    expect(new Set([...current.history, ...older.history].map(row => row.id)).size).toBe(53);
    expect((await getSupplierInvoice(f.ctx, id, { revisionId: older.history.at(-1)!.id }, { db })).purpose).toBe(created.purpose);
  });
  it("edits by exact source version and retains every earlier revision, line and audit", async () => {
    const f = await fixture(), creation = input(f.supplier.id), first = await createSupplierInvoice(f.ctx, creation, { db });
    const old = await getSupplierInvoice(f.ctx, first.id, {}, { db });
    const original = await withTenant(db, f.org, tx => tx.supplierInvoiceRevision.findUniqueOrThrow({ where: { id: old.revisionId }, include: { lines: true } }));
    const values = update(creation, first.id, 0);
    const results = await Promise.allSettled(["Updated invoice A", "Updated invoice B"].map(purpose => updateSupplierInvoice(f.ctx, { ...values, purpose,
      lines: [{ category: "maintenance", amount: "2400.01", propertyId: f.property.id }, { category: "office", costCenter: "company", amount: "100.99" }], dueOn: "2026-09-01" }, { db })));
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter(result => result.status === "rejected" && result.reason instanceof SupplierInvoiceConflictError)).toHaveLength(1);
    const current = await getSupplierInvoice(f.ctx, first.id, {}, { db });
    expect(current).toMatchObject({ version: 1, amount: "2501.00", dueOn: "2026-09-01" }); expect(current.history).toHaveLength(2);
    expect((await getSupplierInvoice(f.ctx, first.id, { revisionId: old.revisionId }, { db })).amount).toBe("2400.00");
    expect(await withTenant(db, f.org, tx => tx.supplierInvoiceRevision.findUniqueOrThrow({ where: { id: original.id }, include: { lines: true } }))).toEqual(original);
    await expect(updateSupplierInvoice(f.ctx, { ...values, expectedVersion: 0 }, { db })).rejects.toBeInstanceOf(SupplierInvoiceConflictError);
  });
  it("archives and restores without changing source history or creating a financial movement", async () => {
    const f = await fixture(), invoice = await createSupplierInvoice(f.ctx, input(f.supplier.id), { db });
    await setSupplierInvoiceArchived(f.ctx, { id: invoice.id, expectedVersion: 0, archived: true, reason: "Dedicated invoice source archive" }, { db });
    expect((await listSupplierInvoices(f.ctx, {}, { db })).invoices).toHaveLength(0);
    expect((await listSupplierInvoices(f.ctx, { includeArchived: true }, { db })).invoices).toHaveLength(1);
    await expect(setSupplierInvoiceArchived(f.ctx, { id: invoice.id, expectedVersion: 1, archived: true, reason: "Repeated invoice archive rejected" }, { db })).rejects.toBeInstanceOf(SupplierInvoiceConflictError);
    await setSupplierInvoiceArchived(f.ctx, { id: invoice.id, expectedVersion: 1, archived: false, reason: "Dedicated invoice source restore" }, { db });
    expect((await getSupplierInvoice(f.ctx, invoice.id, {}, { db })).version).toBe(2);
    await withTenant(db, f.org, async tx => { expect(await tx.supplierInvoiceRevision.count()).toBe(1); expect(await tx.financialTransaction.count()).toBe(0); });
  });
  it("requires current and caller invoice/source grants and denies revoked or narrowed aggregate authority", async () => {
    const f = await fixture(), created = input(f.supplier.id), invoice = await createSupplierInvoice(f.ctx, created, { db });
    const without = (permission: string) => ({ ...f.ctx, authContext: { ...f.ctx.authContext, permissions: new Set([...f.ctx.authContext.permissions].filter(key => key !== permission)) } });
    for (const key of ["supplier_invoice:view", "supplier:view"]) await expect(getSupplierInvoice(without(key), invoice.id, {}, { db })).rejects.toBeInstanceOf(SupplierInvoiceAccessError);
    const narrowed = { ...f.ctx, authContext: { ...f.ctx.authContext, assignments: f.ctx.authContext.assignments?.map(assignment => ({ ...assignment, scope: { organizationId: f.org, scopeType: "property" as const, scopeId: "*" } })) } };
    await expect(listSupplierInvoices(narrowed, {}, { db })).rejects.toBeInstanceOf(SupplierInvoiceAccessError);
    await withTenant(db, f.org, tx => tx.roleAssignment.update({ where: { id: f.assignment.id }, data: { archivedAt: new Date() } }));
    await expect(getSupplierInvoice(f.ctx, invoice.id, {}, { db })).rejects.toBeInstanceOf(SupplierInvoiceAccessError);
    await expect(updateSupplierInvoice(f.ctx, update(created, invoice.id, 0), { db })).rejects.toBeInstanceOf(SupplierInvoiceAccessError);
    expect(await withTenant(db, f.org, tx => tx.supplierInvoiceRevision.count())).toBe(1);
  });
  it("rejects foreign source identities and scopes and keeps invoice audit facts private", async () => {
    const f = await fixture(), other = await fixture();
    await expect(createSupplierInvoice(f.ctx, input(other.supplier.id), { db })).rejects.toBeInstanceOf(SupplierInvoiceAccessError);
    await expect(createSupplierInvoice(f.ctx, { ...input(f.supplier.id), lines: [{ propertyId: other.property.id, category: "maintenance", amount: "1" }] }, { db })).rejects.toBeInstanceOf(SupplierInvoiceAccessError);
    const invoice = await createSupplierInvoice(f.ctx, input(f.supplier.id), { db });
    await expect(getSupplierInvoice(other.ctx, invoice.id, {}, { db })).rejects.toBeInstanceOf(SupplierInvoiceAccessError);
    const event = await withTenant(db, f.org, tx => tx.auditLog.findFirstOrThrow({ where: { resourceId: invoice.id } }));
    const actor = { ...f.ctx, authContext: { ...f.ctx.authContext, permissions: new Set(["audit_log:view"]) } };
    const hidden = presentAuditHistoryRow(actor, event); expect(hidden.after).not.toEqual(event.after); expect(hidden.reason).not.toBe(event.reason);
    const noSupplier = { ...f.ctx, authContext: { ...f.ctx.authContext, permissions: new Set([...f.ctx.authContext.permissions].filter(key => key !== "supplier:view")) } };
    expect(presentAuditHistoryRow(noSupplier, event).reason).not.toBe(event.reason);
    expect(presentAuditHistoryRow(f.ctx, event).after).toEqual(event.after);
  });
  it("prevents source history mutation, deletion, late lines and mismatched revision pointers", async () => {
    const f = await fixture(), invoice = await createSupplierInvoice(f.ctx, input(f.supplier.id), { db }), data = await getSupplierInvoice(f.ctx, invoice.id, {}, { db });
    const line = await withTenant(db, f.org, tx => tx.supplierInvoiceLine.findFirstOrThrow({ where: { revisionId: data.revisionId } }));
    for (const mutate of [
      () => withTenant(db, f.org, tx => tx.supplierInvoiceLine.update({ where: { id: line.id }, data: { amount: "1" } })),
      () => withTenant(db, f.org, tx => tx.supplierInvoiceRevision.delete({ where: { id: data.revisionId } })),
      () => withTenant(db, f.org, tx => tx.supplierInvoice.delete({ where: { id: invoice.id } }))
    ]) await expect(mutate()).rejects.toThrow(/append-only|archived/iu);
    await expect(withTenant(db, f.org, tx => tx.supplierInvoiceLine.create({ data: { organizationId: f.org, revisionId: data.revisionId, position: 2, category: "maintenance", amount: "1", currency: "MAD", createdBy: f.account.id } }))).rejects.toThrow(/conserve/iu);
    await expect(withTenant(db, f.org, tx => tx.$executeRaw(Prisma.sql`UPDATE supplier_invoice SET version=version+1,current_revision_id=${randomUUID()}::uuid WHERE id=${invoice.id}::uuid`))).rejects.toThrow();
    expect((await getSupplierInvoice(f.ctx, invoice.id, {}, { db })).amount).toBe("2400.00");
  });
});
