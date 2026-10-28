import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { Prisma, PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { provisionIntegrationRole } from "./support/database-role";
import { withTenant } from "@/platform/db/tenant";
import { authContextForAccount } from "@/platform/authz/account-context";
import { ensureStandardIdentitySetup } from "@/modules/identity/application/identity-service";
import { createSupplier, getSupplier, listSuppliers, setSupplierArchived, updateSupplier, SupplierAccessError, SupplierConflictError } from "@/modules/finance/application/supplier-service";
import { presentAuditHistoryRow } from "@/modules/audit/application/audit-service";
import { FinanceRepository } from "@/modules/finance/infrastructure/finance-repository";
import { SupplierPayableRepository } from "@/modules/finance/infrastructure/supplier-payable-repository";
import { supplierInvoicePostings, supplierPaymentPostings } from "@/modules/finance/domain/supplier-payable";
import { allocateConfiguredExpense } from "@/modules/finance/domain/configured-finance-rules";
import { Money } from "@/platform/money/money";
import { writeAuditEvent } from "@/platform/audit/audit-writer";

const url = process.env.TEST_DATABASE_URL;
const loggedClient = (datasourceUrl: string) => new PrismaClient({ datasourceUrl, log: [{ emit: "event", level: "query" }] });
let admin: PrismaClient, db: ReturnType<typeof loggedClient>, supplierQueries = 0;
const fields = { displayName: "Dedicated supplier", category: "Laundry", email: "invoices@example.test", phone: "+212661234567" };
const creation = () => ({ ...fields, idempotencyKey: randomUUID(), reason: "Dedicated supplier source acceptance" });
async function fixture(permissions = ["supplier:view", "supplier:create", "supplier:edit"]) {
  const org = randomUUID(); await admin.organization.create({ data: { id: org, name: "Dedicated supplier tenant" } });
  await ensureStandardIdentitySetup(org, { db });
  const actor = await withTenant(db, org, async tx => {
    const person = await tx.person.create({ data: { organizationId: org, displayName: "Supplier source operator" } });
    const account = await tx.userAccount.create({ data: { organizationId: org, personId: person.id } });
    const role = await tx.role.create({ data: { organizationId: org, key: `supplier_qa_${randomUUID()}`, name: "Supplier source role" } });
    for (const key of permissions) {
      const permission = await tx.permission.findFirstOrThrow({ where: { organizationId: org, key } });
      await tx.rolePermission.create({ data: { organizationId: org, roleId: role.id, permissionId: permission.id } });
    }
    const assignment = await tx.roleAssignment.create({ data: { organizationId: org, personId: person.id, userAccountId: account.id, roleId: role.id, scopeType: "organization", validFrom: new Date("2000-01-01") } });
    return { account, assignment };
  });
  return { org, ...actor, ctx: { organizationId: org, actorId: actor.account.id, authContext: await authContextForAccount(org, actor.account.id, { db }) } };
}
describe("canonical supplier source on real PostgreSQL", () => {
  beforeAll(async () => {
    if (!url || !["localhost", "127.0.0.1"].includes(new URL(url).hostname)) throw Error("Dedicated local PostgreSQL required");
    execFileSync(process.execPath, ["node_modules/prisma/build/index.js", "migrate", "deploy"], { env: { ...process.env, DATABASE_URL: url }, stdio: "pipe" });
    admin = new PrismaClient({ datasourceUrl: url }); await provisionIntegrationRole(admin, "alvillas_ops_tests");
    const scoped = new URL(url); scoped.username = "alvillas_ops_tests"; scoped.password = "alvillas_ops_tests"; db = loggedClient(scoped.toString());
    db.$on("query", event => { if (/FROM (?:"public"\.)?"supplier"/u.test(event.query)) supplierQueries++; });
  });
  afterAll(async () => { await db?.$disconnect(); await admin?.$disconnect(); });

  it("recognizes an actual supplier claim and serializes partial settlements without duplicating the expense", async () => {
    const f = await fixture(), supplier = await createSupplier(f.ctx, creation(), { db }), invoiceId = randomUUID();
    const source = await withTenant(db, f.org, async tx => {
      await tx.currency.upsert({ where: { code: "MAD" }, update: {}, create: { code: "MAD", name: "Dirham", minorUnit: 2 } });
      const property = await tx.property.create({ data: { organizationId: f.org, name: "Supplier liability villa", addressLine1: "Local acceptance", city: "Marrakech", propertyType: "VILLA", bedrooms: 1, bathrooms: 1, maxGuests: 2, amenities: [], photoUrls: [] } });
      const owner = await tx.owner.create({ data: { organizationId: f.org, displayName: "Supplier liability owner" } });
      await tx.propertyOwner.create({ data: { organizationId: f.org, propertyId: property.id, ownerId: owner.id } });
      const finance = new FinanceRepository(tx, f.org);
      const bank = await finance.ensureLedgerAccount({ code: "SUPPLIER_QA_BANK", name: "Dedicated bank", accountType: "ASSET_LOCATION", normalSide: "DEBIT" });
      const claim = await finance.ensureLedgerAccount({ code: "SUPPLIER_PAYABLE", name: "Supplier claims", accountType: "CLAIM_OWNERSHIP", normalSide: "CREDIT" });
      const ownerAccount = await finance.ensureLedgerAccount({ code: "OWNER_PAYABLE", name: "Owner claims", accountType: "CLAIM_OWNERSHIP", normalSide: "CREDIT" });
      const amount = Money.of("2400.00", "MAD"), allocation = allocateConfiguredExpense({ default_treatment: "OWNER_PAID" }, { amount, category: "maintenance" });
      const postings = supplierInvoicePostings({ invoiceId, supplierId: supplier.id, liabilityAccountId: claim.id, amount, lines: [{
        id: randomUUID(), propertyId: property.id, category: "maintenance", amount, allocation,
        owners: [{ ownerId: owner.id, ownerName: owner.displayName, shareBps: 10000 }], ownerAmounts: [{ ownerId: owner.id, amount: allocation.ownerAmount }],
        ownerAccounts: new Map([[owner.id, ownerAccount.id]]), companyExpenseAccountId: "", guestReceivableAccountId: ""
      }] });
      const journal = await finance.createFinancialTransaction({ reference: `Supplier invoice ${invoiceId}`, description: "Dedicated supplier claim recipe", occurredAt: new Date(), idempotencyKey: randomUUID(), createdBy: f.account.id, postings });
      await writeAuditEvent(tx, { organizationId: f.org, actorId: f.account.id, action: "local.supplier.claim.created", resourceType: "financial_transaction", resourceId: journal.id,
        after: { supplierId: supplier.id, invoiceId, amount: amount.toJSON() }, reason: "Dedicated supplier claim kernel acceptance", requestId: randomUUID(), occurredAt: new Date() });
      return { bank, claim, ownerAccount, journal };
    });
    const settle = async (value: string) => withTenant(db, f.org, async tx => {
      const payables = new SupplierPayableRepository(tx, f.org); await payables.lockInvoice(invoiceId);
      const outstanding = await payables.outstanding({ supplierId: supplier.id, invoiceId, currency: "MAD" });
      const postings = supplierPaymentPostings({ invoiceId, supplierId: supplier.id, paymentId: randomUUID(), liabilityAccountId: source.claim.id, amount: Money.of(value, "MAD"), outstanding, funding: source.bank });
      const journal = await new FinanceRepository(tx, f.org).createFinancialTransaction({ reference: `Supplier payment ${randomUUID()}`, description: "Dedicated partial supplier settlement", occurredAt: new Date(), idempotencyKey: randomUUID(), createdBy: f.account.id, postings });
      await writeAuditEvent(tx, { organizationId: f.org, actorId: f.account.id, action: "local.supplier.claim.paid", resourceType: "financial_transaction", resourceId: journal.id,
        after: { supplierId: supplier.id, invoiceId, amount: value }, reason: "Dedicated supplier settlement kernel acceptance", requestId: randomUUID(), occurredAt: new Date() });
      return journal;
    });
    await settle("1500.00");
    const results = await Promise.allSettled([settle("800.00"), settle("800.00")]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter(result => result.status === "rejected" && /outstanding/u.test(String(result.reason)))).toHaveLength(1);
    await withTenant(db, f.org, async tx => {
      const payable = new SupplierPayableRepository(tx, f.org);
      expect((await payable.outstanding({ supplierId: supplier.id, invoiceId, currency: "MAD" })).toJSON().amount).toBe("100.00");
      expect((await payable.outstanding({ supplierId: randomUUID(), invoiceId, currency: "MAD" })).toJSON().amount).toBe("0.00");
      expect((await payable.outstanding({ supplierId: supplier.id, invoiceId, currency: "EUR" })).toJSON().amount).toBe("0.00");
      const facts = await tx.posting.findMany({ where: { organizationId: f.org, ledgerAccountId: source.ownerAccount.id } });
      expect(facts).toHaveLength(1); expect(facts[0].amount.toFixed(2)).toBe("2400.00");
      expect(await tx.financialTransaction.findUniqueOrThrow({ where: { id: source.journal.id }, include: { postings: true, reversedByTransactions: true } })).toEqual({ ...source.journal, sealed: true });
      expect(await tx.financialTransaction.count()).toBe(3);
    });
    const accepted = results.find(result => result.status === "fulfilled");
    if (accepted?.status !== "fulfilled") throw Error("An actual settlement is required for reversal acceptance");
    await withTenant(db, f.org, async tx => {
      const payables = new SupplierPayableRepository(tx, f.org); await payables.lockInvoice(invoiceId);
      const original = accepted.value;
      const reversed = await new FinanceRepository(tx, f.org).createFinancialTransaction({ reference: `Supplier payment reversal ${randomUUID()}`, description: "Dedicated reasoned supplier settlement reversal", occurredAt: new Date(), idempotencyKey: randomUUID(), createdBy: f.account.id, reversesTransactionId: original.id,
        postings: original.postings.map(row => ({ ledgerAccountId: row.ledgerAccountId, side: row.side === "CREDIT" ? "DEBIT" : "CREDIT", amount: Money.of(row.amount.toString(), row.currency), bucket: row.bucket!, dimensions: row.dimensions as Record<string, unknown> })) });
      await writeAuditEvent(tx, { organizationId: f.org, actorId: f.account.id, action: "local.supplier.claim.reversed", resourceType: "financial_transaction", resourceId: reversed.id,
        after: { originalTransactionIds: [original.id], reversalTransactionIds: [reversed.id] }, reason: "Dedicated reasoned supplier settlement reversal", requestId: randomUUID(), occurredAt: new Date() });
      expect((await payables.outstanding({ supplierId: supplier.id, invoiceId, currency: "MAD" })).toJSON().amount).toBe("900.00");
    });
    await settle("900.00");
    await withTenant(db, f.org, async tx => {
      expect((await new SupplierPayableRepository(tx, f.org).outstanding({ supplierId: supplier.id, invoiceId, currency: "MAD" })).toJSON().amount).toBe("0.00");
      expect(await tx.posting.count({ where: { ledgerAccountId: source.ownerAccount.id } })).toBe(1);
      expect(await tx.financialTransaction.count()).toBe(5);
    });
    const other = await fixture();
    expect((await withTenant(db, other.org, tx => new SupplierPayableRepository(tx, other.org).outstanding({ supplierId: supplier.id, invoiceId, currency: "MAD" }))).toJSON().amount).toBe("0.00");
  });
  it("creates one attributed source under concurrent retries and rejects changed intent", async () => {
    const f = await fixture(), input = creation();
    const results = await Promise.all(Array.from({ length: 4 }, () => createSupplier(f.ctx, input, { db })));
    expect(new Set(results.map(row => row.id)).size).toBe(1);
    const supplier = await getSupplier(f.ctx, results[0].id, { db });
    expect(supplier).toMatchObject({ reference: "SUP-0001", version: 0, displayName: fields.displayName, email: fields.email, archived: false });
    expect(await withTenant(db, f.org, tx => tx.auditLog.count({ where: { resourceId: supplier.id, action: "finance.supplier.created" } }))).toBe(1);
    await expect(createSupplier(f.ctx, { ...input, category: "Maintenance" }, { db })).rejects.toBeInstanceOf(SupplierConflictError);
  });
  it("uses exact edit versions and reasoned archive/restore without hard deletion", async () => {
    const f = await fixture(), source = await createSupplier(f.ctx, creation(), { db });
    const changes = await Promise.allSettled(["Updated supplier A", "Updated supplier B"].map(displayName => updateSupplier(f.ctx, { ...fields, displayName, id: source.id, expectedVersion: 0, reason: "Dedicated source edit" }, { db })));
    expect(changes.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(changes.filter(result => result.status === "rejected" && result.reason instanceof SupplierConflictError)).toHaveLength(1);
    await expect(setSupplierArchived(f.ctx, { id: source.id, expectedVersion: 1, archived: false, reason: "Invalid active supplier restoration" }, { db })).rejects.toBeInstanceOf(SupplierConflictError);
    await setSupplierArchived(f.ctx, { id: source.id, expectedVersion: 1, archived: true, reason: "Dedicated supplier archive" }, { db });
    await expect(setSupplierArchived(f.ctx, { id: source.id, expectedVersion: 2, archived: true, reason: "Invalid repeated supplier archival" }, { db })).rejects.toBeInstanceOf(SupplierConflictError);
    expect((await listSuppliers(f.ctx, {}, { db })).suppliers).toEqual([]);
    expect((await listSuppliers(f.ctx, { includeArchived: true }, { db })).suppliers).toHaveLength(1);
    await setSupplierArchived(f.ctx, { id: source.id, expectedVersion: 2, archived: false, reason: "Dedicated supplier restore" }, { db });
    expect((await getSupplier(f.ctx, source.id, { db })).version).toBe(3);
    await expect(withTenant(db, f.org, tx => tx.supplier.delete({ where: { id: source.id } }))).rejects.toThrow(/archived/iu);
  });
  it("requires caller and stored source permissions, including revocation after prior successful reads", async () => {
    const f = await fixture(), source = await createSupplier(f.ctx, creation(), { db });
    await expect(getSupplier({ ...f.ctx, authContext: { ...f.ctx.authContext, permissions: new Set() } }, source.id, { db })).rejects.toBeInstanceOf(SupplierAccessError);
    await withTenant(db, f.org, tx => tx.roleAssignment.update({ where: { id: f.assignment.id }, data: { validTo: new Date("2020-01-01") } }));
    await expect(getSupplier(f.ctx, source.id, { db })).rejects.toBeInstanceOf(SupplierAccessError);
    await expect(createSupplier(f.ctx, creation(), { db })).rejects.toBeInstanceOf(SupplierAccessError);
    expect(await withTenant(db, f.org, tx => tx.supplier.count())).toBe(1);
  });
  it("rolls back an edit when stored authority is revoked while a real supplier row lock blocks the write", async () => {
    const f = await fixture(), source = await createSupplier(f.ctx, creation(), { db });
    let locked!: () => void, release!: () => void;
    const reached = new Promise<void>(resolve => locked = resolve), gate = new Promise<void>(resolve => release = resolve);
    const holder = withTenant(admin, f.org, async tx => {
      await tx.$queryRaw(Prisma.sql`SELECT id FROM supplier WHERE organization_id=${f.org}::uuid AND id=${source.id}::uuid FOR UPDATE`);
      locked(); await gate;
    });
    await reached;
    const editing = updateSupplier(f.ctx, { ...fields, displayName: "Revoked source edit", id: source.id, expectedVersion: 0, reason: "Dedicated delayed source edit" }, { db })
      .then(value => ({ ok: true as const, value }), error => ({ ok: false as const, error: error as unknown }));
    try {
      await vi.waitFor(async () => {
        const [row] = await admin.$queryRaw<Array<{ waiting: boolean }>>`SELECT EXISTS(SELECT 1 FROM pg_stat_activity
          WHERE usename='alvillas_ops_tests' AND wait_event_type='Lock' AND lower(query) LIKE '%update%supplier%') AS waiting`;
        expect(row.waiting).toBe(true);
      }, { timeout: 10000 });
      await withTenant(admin, f.org, tx => tx.roleAssignment.update({ where: { id: f.assignment.id }, data: { archivedAt: new Date() } }));
    } finally { release(); await holder; }
    const result = await editing; expect(result.ok).toBe(false); if (!result.ok) expect(result.error).toBeInstanceOf(SupplierAccessError);
    const unchanged = await withTenant(admin, f.org, tx => tx.supplier.findUniqueOrThrow({ where: { id: source.id } }));
    expect(unchanged).toMatchObject({ version: 0, displayName: fields.displayName });
    expect(await withTenant(admin, f.org, tx => tx.auditLog.count({ where: { resourceId: source.id, action: "finance.supplier.updated" } }))).toBe(0);
  });
  it("rejects operational or financial grants without supplier access", async () => {
    const f = await fixture(["property:view", "financial_transaction:view"]);
    await expect(listSuppliers(f.ctx, {}, { db })).rejects.toBeInstanceOf(SupplierAccessError);
    await expect(createSupplier(f.ctx, creation(), { db })).rejects.toBeInstanceOf(SupplierAccessError);
    expect(await withTenant(db, f.org, tx => tx.auditLog.count({ where: { resourceType: "supplier" } }))).toBe(0);
  });
  it("isolates tenants both in services and RLS and prevents cross-tenant creator references", async () => {
    const f = await fixture(), foreign = await fixture(), source = await createSupplier(foreign.ctx, creation(), { db });
    await expect(getSupplier(f.ctx, source.id, { db })).rejects.toBeInstanceOf(SupplierAccessError);
    expect(await withTenant(db, f.org, tx => tx.supplier.findMany({ where: { organizationId: foreign.org } }))).toEqual([]);
    await expect(createSupplier({ ...f.ctx, organizationId: foreign.org }, creation(), { db })).rejects.toBeInstanceOf(SupplierAccessError);
    await expect(withTenant(db, f.org, tx => tx.supplier.create({ data: { organizationId: f.org, reference: "BAD", displayName: "Invalid source", category: "Laundry", idempotencyKey: randomUUID(), requestFingerprint: "a".repeat(64), createdBy: foreign.account.id } }))).rejects.toThrow();
  });
  it("enforces immutable source identity and same-transaction audit proof in PostgreSQL", async () => {
    const f = await fixture(), source = await createSupplier(f.ctx, creation(), { db });
    await expect(withTenant(db, f.org, tx => tx.supplier.update({ where: { id: source.id }, data: { reference: "REWRITTEN", version: { increment: 1 } } }))).rejects.toThrow(/immutable/iu);
    await expect(withTenant(db, f.org, tx => tx.supplier.update({ where: { id: source.id }, data: { displayName: "No audit", version: { increment: 1 } } }))).rejects.toThrow(/audit/iu);
    expect((await getSupplier(f.ctx, source.id, { db })).version).toBe(0);
  });
  it("pages and searches actual supplier rows with tenant category boundaries", async () => {
    const f = await fixture();
    for (let index = 0; index < 53; index++) await createSupplier(f.ctx, { ...creation(), displayName: `Dedicated supplier ${String(index).padStart(2, "0")}` }, { db });
    supplierQueries = 0;
    const first = await listSuppliers(f.ctx, { category: "Laundry" }, { db }); expect(supplierQueries).toBe(1);
    const next = await listSuppliers(f.ctx, { category: "Laundry", after: first.next }, { db }); expect(supplierQueries).toBe(2);
    expect(first.suppliers).toHaveLength(50); expect(next.suppliers).toHaveLength(3); expect(next.next).toBeUndefined();
    expect(new Set([...first.suppliers, ...next.suppliers].map(row => row.id)).size).toBe(53);
    expect((await listSuppliers(f.ctx, { query: "supplier 01" }, { db })).suppliers).toHaveLength(1);
  });
  it("masks supplier audit facts unless the reader also has source authority", async () => {
    const f = await fixture(), source = await createSupplier(f.ctx, creation(), { db });
    const row = await withTenant(db, f.org, tx => tx.auditLog.findFirstOrThrow({ where: { resourceId: source.id } }));
    const auditContext = { organizationId: f.org, actorId: f.account.id, personId: f.account.personId, authContext: { ...f.ctx.authContext,
      permissions: new Set(["audit_log:view"]), assignments: undefined, scopes: [{ organizationId: f.org, scopeType: "organization" as const }] } };
    const hidden = presentAuditHistoryRow(auditContext, row);
    expect(hidden.before).toBe("••••••"); expect(hidden.after).toBe("••••••"); expect(hidden.reason).toBe("••••••");
    expect(JSON.stringify(row.after)).not.toContain(fields.email);
    const allowed = presentAuditHistoryRow({ ...auditContext, authContext: { ...auditContext.authContext, permissions: new Set(["audit_log:view", "supplier:view"]) } }, row);
    expect(allowed.after).toEqual(row.after);
  });
});
