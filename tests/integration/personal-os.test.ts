import { randomBytes, randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withTenant } from "@/platform/db/tenant";
import { FinanceRepository } from "@/modules/finance/infrastructure/finance-repository";
import { ensureStandardIdentitySetup } from "@/modules/identity/application/identity-service";
import { ConfigRuleRepository } from "@/platform/config/config-rule-repository";
import { businessPersonalTransferPolicyKey } from "@/platform/ledger/business-personal-transfer-policy";
import { Money } from "@/platform/money/money";
import { HouseholdRepository, PersonalAccessDenied, PersonalConflict } from "@/modules/personal/infrastructure/household-repository";
import { PersonalFinanceRepository } from "@/modules/personal/infrastructure/personal-finance-repository";
import { PersonalDocumentRepository } from "@/modules/personal/infrastructure/personal-document-repository";
import { PersonalTransferRepository } from "@/modules/personal/infrastructure/personal-transfer-repository";
import { provisionIntegrationRole } from "./support/database-role";

let admin: PrismaClient;
let db: PrismaClient;
let households: HouseholdRepository;

beforeAll(async () => {
  const url = new URL(process.env.TEST_DATABASE_URL ?? "");
  if (!["127.0.0.1", "localhost"].includes(url.hostname)) throw new Error("Isolated personal integration database required");
  admin = new PrismaClient({ datasourceUrl: url.toString() });
  await provisionIntegrationRole(admin, "alvillas_app_test");
  url.username = url.password = "alvillas_app_test";
  db = new PrismaClient({ datasourceUrl: url.toString() });
  households = new HouseholdRepository(db);
});

afterAll(async () => {
  await Promise.all([db?.$disconnect(), admin?.$disconnect()]);
});

async function fixture() {
  const { id: organizationId } = await admin.organization.create({ data: { name: "Personal OS test tenant", baseCurrency: "MAD" } });
  const actors = await withTenant(db, organizationId, async (tx) => {
    const accounts = [];
    for (const displayName of ["Steward", "Child", "Business approver"]) {
      const person = await tx.person.create({ data: { organizationId, displayName } });
      const account = await tx.userAccount.create({ data: { organizationId, personId: person.id } });
      accounts.push({ organizationId, accountId: account.id, personId: person.id });
    }
    return accounts;
  });
  const [actor, child, financeActor] = actors;
  const household = await households.provision(actor, "Private household", "Adult steward");
  return { actor, child, financeActor, household, organizationId };
}

const input = (kind = "INCOME", changes: Record<string, unknown> = {}) => ({
  id: randomUUID(), kind, label: "Private record", category: "Private category", effectiveOn: "2026-11-19",
  amount: "9007199254740993.07", currency: "MAD", ...changes
});

describe("Personal OS on isolated PostgreSQL", () => {
  it("isolates household and tenant reads, authorizes only grants and preserves a private audit", async () => {
    const { actor, child, financeActor, household, organizationId } = await fixture();
    const other = await fixture();
    const record = input();
    await expect(households.provision(actor, "Private household", "Adult steward")).resolves.toBe(household);
    await expect(households.scoped(financeActor, household, (scope) => scope.name())).rejects.toBeInstanceOf(PersonalAccessDenied);
    await expect(households.scoped(other.actor, household, (scope) => scope.name())).rejects.toBeInstanceOf(PersonalAccessDenied);
    await expect(households.scoped(actor, other.household, (scope) => scope.name())).rejects.toBeInstanceOf(PersonalAccessDenied);
    const create = () => households.scoped(actor, household, (scope) => new PersonalFinanceRepository(scope).record(record));
    await Promise.all([create(), create()]);
    await households.scoped(actor, household, (scope) => scope.setMember({
      accountId: child.accountId, displayName: "Child", isChild: true, grants: ["income:view", "reports:view"]
    }));
    await expect(households.listHouseholds(child)).resolves.toEqual([household]);
    await households.scoped(child, household, async (scope) => {
      const finance = new PersonalFinanceRepository(scope);
      expect((await finance.list("INCOME")).items).toHaveLength(1);
      await expect(finance.record(input("INCOME"))).rejects.toBeInstanceOf(PersonalAccessDenied);
      await expect(finance.list("EXPENSE")).rejects.toBeInstanceOf(PersonalAccessDenied);
      await expect(scope.auditTrail()).rejects.toBeInstanceOf(PersonalAccessDenied);
    });
    await households.scoped(actor, household, async (scope) => {
      await new PersonalFinanceRepository(scope).record(input("EXPENSE"));
      expect((await scope.auditTrail()).items.map((entry) => entry.action)).toContain("personal.member_changed");
    });
    await households.scoped(child, household, async (scope) => {
      expect(await new PersonalFinanceRepository(scope).report("2026-11-01", "2026-11-30")).toEqual([
        { amount: "9007199254740993.07", kind: "INCOME", category: "Private category", currency: "MAD" }
      ]);
    });
    await expect(households.scoped(actor, household, (scope) => scope.tx.$executeRaw`
      UPDATE personal_audit_event SET action = 'altered' WHERE household_id = ${household}::uuid
    `)).rejects.toThrow("append-only");
    await households.scoped(actor, household, (scope) => scope.revokeMember(child.accountId));
    await expect(households.listHouseholds(child)).resolves.toEqual([]);
    await expect(households.scoped(child, household, (scope) => scope.name())).rejects.toBeInstanceOf(PersonalAccessDenied);
    const business = await withTenant(db, organizationId, async (tx) => ({
      personal: await tx.personalFinanceEntry.count(), audits: await tx.personalAuditEvent.count(),
      journal: await tx.financialTransaction.count(), businessAudit: await tx.auditLog.count({ where: { action: { startsWith: "personal." } } })
    }));
    expect(business).toEqual({ personal: 0, audits: 0, journal: 0, businessAudit: 0 });
  });

  it("preserves movements, dated revisions, savings progress and an encrypted document original", async () => {
    const { actor, household } = await fixture();
    const prior = process.env.PERSONAL_ENCRYPTION_KEYS;
    process.env.PERSONAL_ENCRYPTION_KEYS = "personal-test:" + randomBytes(32).toString("base64");
    const pdf = "%PDF-1.7\n%%EOF";
    try {
      await households.scoped(actor, household, async (scope) => {
        const finance = new PersonalFinanceRepository(scope);
        const docs = new PersonalDocumentRepository(scope);
        await finance.record(input("INCOME"));
        const first = (await finance.list("INCOME")).items[0];
        expect(first.id[14]).toBe("7");
        const reversal = { id: randomUUID(), sourceId: first.id, reason: "Corrected duplicate" };
        await finance.reverse("INCOME", reversal);
        await finance.reverse("INCOME", reversal);
        await finance.record(input("BUDGET", { amount: "150.99" }));
        await finance.record(input("EXPENSE", { amount: "50.01" }));
        const budgets = (await finance.list("BUDGET")).items;
        expect(await finance.budgetSpending(budgets)).toEqual({ [budgets[0].seriesId]: "50.01" });
        await finance.record(input("SAVINGS_GOAL", { amount: "200.01" }));
        const goal = (await finance.list("SAVINGS_GOAL")).items[0];
        await finance.record(input("SAVINGS_MOVEMENT", { goalId: goal.id, amount: "47.01" }));
        await finance.record(input("SAVINGS_MOVEMENT", { goalId: goal.id, withdrawal: true, amount: "8.05" }));
        expect(await finance.savingsProgress([goal.id], "2026-11-30")).toEqual({ [goal.id]: "38.96" });
        await finance.record(input("ASSET", { amount: "700.00" }));
        const asset = (await finance.list("ASSET")).items[0];
        await finance.record(input("ASSET", { seriesId: asset.id, amount: "600.08", effectiveOn: "2026-11-20" }));
        expect((await finance.list("ASSET", undefined, asset.id)).items.map((entry) => entry.amount)).toEqual(["600.08", "700.00"]);
        expect(await finance.report("2026-11-01", "2026-11-19", "positions")).toEqual([
          { kind: "ASSET", currency: "MAD", category: "Private category", amount: "700.00" }
        ]);
        expect((await finance.report("2026-11-01", "2026-11-30")).find((entry) => entry.kind === "INCOME")?.amount).toBe("0.00");
        await docs.upload({ id: randomUUID(), displayName: "Private file", file: new File([pdf], "file.pdf", { type: "application/pdf" }) });
        const item = (await docs.list(false)).items[0];
        const raw = await scope.tx.personalDocument.findFirstOrThrow({ where: { id: item.id } });
        expect(Buffer.from(raw.ciphertext).includes(Buffer.from(pdf))).toBe(false);
        expect(Buffer.from((await docs.download(item.id))!.bytes).toString()).toBe(pdf);
        await docs.archive(item.id, true);
        await expect(docs.download(item.id)).resolves.toBeNull();
        await docs.archive(item.id, false);
        expect(Buffer.from((await docs.download(item.id))!.bytes).toString()).toBe(pdf);
      });
    } finally {
      if (prior === undefined) delete process.env.PERSONAL_ENCRYPTION_KEYS;
      else process.env.PERSONAL_ENCRYPTION_KEYS = prior;
    }
  });

  it("confirms a configured categorized settlement only with both grants, preserving every company posting", async () => {
    const { actor, financeActor, household, organizationId } = await fixture();
    await ensureStandardIdentitySetup(organizationId, { db });
    const journal = await withTenant(db, organizationId, async (tx) => {
      const role = await tx.role.create({ data: { organizationId, key: "verified-transfer-approver", name: "Transfer approver" } });
      for (const key of ["financial_transaction:view", "financial_transaction:approve"]) {
        const permission = await tx.permission.findFirstOrThrow({ where: { organizationId, key } });
        await tx.rolePermission.create({ data: { organizationId, roleId: role.id, permissionId: permission.id } });
      }
      await tx.roleAssignment.create({ data: { organizationId, userAccountId: financeActor.accountId, personId: financeActor.personId,
        roleId: role.id, scopeType: "organization", validFrom: new Date("2020-01-01") } });
      await new ConfigRuleRepository(tx, organizationId).createVersion({
        key: businessPersonalTransferPolicyKey, scopeType: "organization", createdBy: financeActor.accountId,
        effectiveFrom: new Date("2020-01-01"), reason: "Approved fixture categories",
        value: { approval_reference: "CONFIRMED-FIXTURE", categories: [
          { category: "Approved settlement", cash_account_code: "BANK", company_account_code: "CAPITAL" }
        ] }
      });
      const ledger = new FinanceRepository(tx, organizationId);
      const bank = await ledger.ensureLedgerAccount({ code: "BANK", name: "Bank", accountType: "ASSET_LOCATION", normalSide: "DEBIT" });
      const capital = await ledger.ensureLedgerAccount({ code: "CAPITAL", name: "Company capital", accountType: "ALVILLAS_OWN", normalSide: "CREDIT" });
      const amount = Money.of("200.08", "MAD");
      return ledger.createFinancialTransaction({
        reference: "TRANSFER-" + randomUUID(), description: "Verified business transfer fixture",
        idempotencyKey: randomUUID(), createdBy: financeActor.accountId, occurredAt: new Date("2026-11-19T12:00:00Z"),
        postings: [
          { ledgerAccountId: bank.id, side: "CREDIT", amount, bucket: null, dimensions: {} },
          { ledgerAccountId: capital.id, side: "DEBIT", amount, bucket: null, dimensions: {} }
        ]
      });
    });
    const getJournal = () => withTenant(db, organizationId, (tx) =>
      tx.financialTransaction.findMany({ where: { organizationId }, include: { postings: { orderBy: { id: "asc" } } } }));
    const before = await getJournal();
    await households.scoped(actor, household, (scope) => scope.setMember({
      accountId: financeActor.accountId, displayName: "Verifier", isChild: false, grants: ["transfers:view", "transfers:edit"]
    }));
    const request = { id: randomUUID(), category: "Approved settlement", direction: "TO_PERSONAL", amount: "200.08", currency: "MAD", effectiveOn: "2026-11-19" };
    const id = await households.scoped(actor, household, async (scope) => {
      const transfers = new PersonalTransferRepository(scope);
      await transfers.request(request);
      await transfers.request(request);
      expect(await transfers.settledTotals("2026-11-01", "2026-11-30")).toEqual([]);
      return (await transfers.list()).items[0].id;
    });
    const confirm = { id, businessTransactionId: journal.id };
    await expect(households.scoped(actor, household, (scope) =>
      new PersonalTransferRepository(scope).confirm(confirm))).rejects.toBeInstanceOf(PersonalAccessDenied);
    await households.scoped(financeActor, household, async (scope) => {
      const transfers = new PersonalTransferRepository(scope);
      await transfers.confirm(confirm);
      await transfers.confirm(confirm);
      await expect(transfers.confirm({ id, businessTransactionId: randomUUID() })).rejects.toBeInstanceOf(PersonalConflict);
      const [item] = (await transfers.list()).items;
      expect(item.status).toBe("CONFIRMED");
      expect(JSON.stringify(item)).not.toContain(journal.id);
      expect(await transfers.settledTotals("2026-11-01", "2026-11-30")).toEqual([{ currency: "MAD", amount: "200.08" }]);
    });
    expect(await getJournal()).toEqual(before);
  });
});
