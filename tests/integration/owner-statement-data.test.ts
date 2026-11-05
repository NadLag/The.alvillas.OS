import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withTenant } from "@/platform/db/tenant";
import { ConfigRuleRepository } from "@/platform/config/config-rule-repository";
import { FinanceRepository } from "@/modules/finance/infrastructure/finance-repository";
import { Money } from "@/platform/money/money";
import { ownerPortalActorContextFromSession } from "@/modules/owner-portal/application/owner-portal-access";
import { getOwnerStatement } from "@/modules/owner-portal/application/owner-portal-service";
import { provisionIntegrationRole } from "./support/database-role";
import { buildOwnerStatement, statementPeriodDates } from "@/platform/ledger/owner-statement";
import { OwnerStatementRepository } from "@/platform/ledger/owner-statement-repository";
import { ensureStandardIdentitySetup, startTotpEnrollment, confirmTotpEnrollment } from "@/modules/identity/application/identity-service";
import { identityActorContextFromSession } from "@/modules/identity/application/identity-access";
import { authContextForAccount } from "@/platform/authz/account-context";
import { totpCode } from "@/platform/auth/totp";
import { prepareAccountantExport } from "@/modules/finance/application/accountant-export-service";
import { exportAccountantFile, type AccountantExportLabels } from "@/modules/finance/application/accountant-file-export";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { accountantExportFixtureAuthority } from "./support/accountant-export";
import en from "../../messages/en.json";
import fr from "../../messages/fr.json";
import { AccountantExportChangedError } from "@/modules/finance/domain/accountant-export";

const url = process.env.TEST_DATABASE_URL; let admin: PrismaClient, db: PrismaClient;
beforeAll(async () => {
  const target = url ? new URL(url) : null;
  if (!target || !["localhost", "127.0.0.1"].includes(target.hostname) || !(target.pathname.startsWith("/alvillas_automation_statement168_") || target.pathname.startsWith("/alvillas_automation_integrity167_") || process.env.GITHUB_ACTIONS === "true" && target.pathname === "/alvillas_os")) throw Error("Owned native statement database required");
  admin = new PrismaClient({ datasourceUrl: url }); await provisionIntegrationRole(admin, "alvillas_ops_tests");
  const restricted = new URL(url!); restricted.username = restricted.password = "alvillas_ops_tests"; db = new PrismaClient({ datasourceUrl: restricted.toString() });
  expect(await db.$queryRaw`SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user`).toEqual([{ rolsuper: false, rolbypassrls: false }]);
  for (const code of ["MAD", "EUR"]) await admin.currency.upsert({ where: { code }, update: {}, create: { code, name: code, minorUnit: 2 } });
});
afterAll(async () => { await db?.$disconnect(); await admin?.$disconnect(); });

async function fixture(timezone = "Europe/Paris") {
  const org = randomUUID(); await admin.organization.create({ data: { id: org, name: "Original statement data acceptance", baseCurrency: "MAD" } });
  const f = await withTenant(db, org, async tx => {
    const person = await tx.person.create({ data: { organizationId: org, displayName: "Actual statement owner" } }),
      account = await tx.userAccount.create({ data: { organizationId: org, personId: person.id, email: "statement-" + randomUUID() + "@example.test" } }),
      owner = await tx.owner.create({ data: { organizationId: org, displayName: "Original entitled owner" } }),
      property = await tx.property.create({ data: { organizationId: org, name: "Original statement villa", addressLine1: "Native statement acceptance", city: "Marrakech", propertyType: "VILLA", bedrooms: 1, bathrooms: 1, maxGuests: 2, amenities: [], photoUrls: [] } });
    await tx.propertyOwner.create({ data: { organizationId: org, propertyId: property.id, ownerId: owner.id, shareBps: 10000, isPrimary: true } });
    await tx.ownerPortalAccess.create({ data: { organizationId: org, userAccountId: account.id, ownerId: owner.id } });
    await new ConfigRuleRepository(tx, org).createVersion({ key: "finance.accounting_periods", scopeType: "organization", effectiveFrom: new Date("2000-01-01"), createdBy: account.id,
      value: { timezone, allow_early_close: false, max_reopen_seconds: 60 }, reason: "Explicit original financial statement calendar" });
    const finance = new FinanceRepository(tx, org), bank = await finance.ensureLedgerAccount({ code: "STATEMENT_BANK", name: "Original custody", accountType: "ASSET_LOCATION", normalSide: "DEBIT" }),
      claim = await finance.ensureLedgerAccount({ code: "OWNER_PAYABLE", name: "Original owner claim", accountType: "CLAIM_OWNERSHIP", normalSide: "CREDIT" });
    return { org, account, person, owner, property, bank, claim };
  });
  const ctx = await ownerPortalActorContextFromSession({ user: { id: f.account.id, personId: f.person.id, organizationId: org, email: f.account.email,
    preferredLocale: "en", sessionId: randomUUID(), sessionRevoked: false, securitySetupRequired: false }, expires: new Date(Date.now() + 3600000).toISOString() }, { db });
  if (!ctx) throw Error("Actual native owner access required"); return { ...f, ctx };
}
async function append(f: Awaited<ReturnType<typeof fixture>>, currency: string, amount: string, at: string, side: "CREDIT" | "DEBIT" = "CREDIT") {
  return withTenant(db, f.org, tx => {
    const value = Money.of(amount, currency), dimensions = { owner_id: f.owner.id, property_id: f.property.id }, bucket = side === "CREDIT" ? "OWNER_REVENUE" : "OWNER_EXPENSE";
    return new FinanceRepository(tx, f.org).createFinancialTransaction({ reference: "ORIGINAL-STATEMENT:" + randomUUID(), description: "Original exact statement source", occurredAt: new Date(at), createdBy: f.account.id, idempotencyKey: randomUUID(),
      postings: [{ ledgerAccountId: f.bank.id, side: side === "CREDIT" ? "DEBIT" : "CREDIT", amount: value, bucket, dimensions }, { ledgerAccountId: f.claim.id, side, amount: value, bucket, dimensions }] });
  });
}
const facts = (org: string) => withTenant(db, org, tx => tx.$queryRaw<Array<{ kind: string; xmin: string; body: string }>>`
  SELECT 'journal' AS kind,xmin::text,to_jsonb(t)::text AS body FROM financial_transaction t WHERE organization_id=${org}::uuid
  UNION ALL SELECT 'posting',xmin::text,to_jsonb(p)::text FROM posting p WHERE organization_id=${org}::uuid ORDER BY kind,body`);

async function exporter(f: Awaited<ReturnType<typeof fixture>>) {
  await ensureStandardIdentitySetup(f.org, { db });
  const staff = await withTenant(db, f.org, async tx => {
    const person = await tx.person.create({ data: { organizationId: f.org, displayName: "Independent actual accountant" } });
    const account = await tx.userAccount.create({ data: { organizationId: f.org, personId: person.id, mfaRequired: true, email: "actual-accountant-" + randomUUID() + "@example.test" } });
    return { org: f.org, person, account };
  });
  await accountantExportFixtureAuthority(db, staff, ["OWNER_STATEMENTS"]);
  const ctx = await identityActorContextFromSession({ user: { id: staff.account.id, personId: staff.person.id, organizationId: f.org,
    preferredLocale: "en", sessionId: randomUUID(), sessionRevoked: false, securitySetupRequired: true }, expires: new Date(Date.now() + 3600000).toISOString() }, { db });
  if (!ctx) throw Error("Actual own-factor enrollment context required");
  const pending = await startTotpEnrollment(ctx, { db }); await confirmTotpEnrollment(ctx, pending.credentialId, totpCode(pending.secret), { db });
  return { organizationId: f.org, actorId: staff.account.id, authContext: { ...await authContextForAccount(f.org, staff.account.id, { db }), personId: staff.person.id } };
}

describe("native shared statement generation", () => {
  it("withholds rendered bytes and success history when the financial calendar changes during export", async () => {
    const f = await fixture(), actor = await exporter(f); await append(f, "MAD", "0.07", "2026-11-01T23:30:00Z"); const original = await facts(f.org);
    const input = { kind: "OWNER_STATEMENTS", format: "CSV", locale: "en", fromOn: "2026-11-02", toOn: "2026-11-02", currency: "MAD", ownerId: f.owner.id,
      propertyId: f.property.id, reason: "Protect actual original statement generation from a concurrent financial calendar change" };
    let rendered = false;
    await expect(prepareAccountantExport(actor, input, async () => {
      rendered = true; await withTenant(db, f.org, tx => new ConfigRuleRepository(tx, f.org).createVersion({ key: "finance.accounting_periods", scopeType: "organization",
        effectiveFrom: new Date("2000-01-01"), createdBy: actor.actorId, value: { timezone: "Asia/Tokyo", allow_early_close: false, max_reopen_seconds: 60 },
        reason: "Publish an independently committed replacement financial calendar during rendering" })); return new Uint8Array([1, 2, 3]);
    }, { db })).rejects.toThrow(AccountantExportChangedError);
    expect(rendered).toBe(true); expect(await facts(f.org)).toEqual(original);
    expect(await withTenant(db, f.org, tx => tx.auditLog.count({ where: { action: "finance.accountant_export.generated" } }))).toBe(0);
  });
  it("shares the financial calendar and exact source totals between owner portal and real CSV/PDF exports", async () => {
    const f = await fixture(), actor = await exporter(f);
    await append(f, "EUR", "9007199254740993.07", "2026-11-01T23:30:00Z");
    await append(f, "EUR", "0.03", "2026-11-02T12:00:00Z", "DEBIT"); await append(f, "MAD", "0.07", "2026-11-02T12:01:00Z");
    const original = await facts(f.org), input = { kind: "OWNER_STATEMENTS", format: "CSV", locale: "en", fromOn: "2026-11-02", toOn: "2026-11-02", currency: "EUR",
      ownerId: f.owner.id, propertyId: f.property.id, reason: "Verify actual original owner statement documents and source consistency" },
      statement = await getOwnerStatement(f.ctx, f.property.id, { from: input.fromOn, to: input.toOn, currency: input.currency }, { db, requestId: randomUUID() }),
      source = await prepareAccountantExport(actor, input, document => document, { db });
    expect(source.timezone).toBe(statement.timezone); expect(source.timezone).toBe("Europe/Paris");
    expect(source.rows[0].cells).toMatchObject({ opening: { value: statement.openingBalance.toJSON().amount }, credits: { value: statement.periodCreditTotal.toJSON().amount },
      debits: { value: statement.periodDebitTotal.toJSON().amount }, closing: { value: statement.closingBalance.toJSON().amount } });
    expect(statement.closingBalance.toJSON().amount).toBe("9007199254740993.04");
    expect(source.rows.slice(1).map(row => row.cells.postingId?.value)).toEqual(statement.lines.map(line => line.postingId));
    for (const locale of ["en", "fr"] as const) {
      const messages = ({ en, fr })[locale].AccountantExports, labels: AccountantExportLabels = { title: messages.reports.OWNER_STATEMENTS, headers: messages.columns,
        metadata: messages.metadata, metadataRow: messages.metadataRow, sourceRow: messages.sourceRow, metadataSheet: messages.metadataSheet, dataSheet: messages.dataSheet },
        csv = new TextDecoder().decode(await exportAccountantFile(actor, { ...input, locale }, labels, { db }));
      expect(csv).toContain("Europe/Paris"); expect(csv).toContain("9007199254740993.04"); expect(csv).toContain("OWNER_EXPENSE");
      expect(csv).toContain("9007199254740993.07"); expect(csv).not.toContain("MAD");
      const bytes = await exportAccountantFile(actor, { ...input, locale, format: "PDF" }, labels, { db });
      expect(new TextDecoder().decode(bytes.slice(0, 5))).toBe("%PDF-");
      const task = getDocument({ data: bytes, useSystemFonts: false, useWorkerFetch: false, useWasm: false, disableFontFace: true }); let text = "";
      try { const pdf = await task.promise; for (let page = 1; page <= pdf.numPages; page++) text += (await (await pdf.getPage(page)).getTextContent()).items.map(item => "str" in item ? item.str : "").join("\n"); }
      finally { await task.destroy(); }
      expect(text).toContain("9007199254740993.04"); expect(text).toContain("Europe/Paris");
      for (const line of statement.lines) expect(text).toContain(line.postingId);
    }
    expect(await facts(f.org)).toEqual(original);
    const audit = await withTenant(db, f.org, tx => tx.auditLog.findMany({ where: { action: "finance.accountant_export.generated" }, select: { after: true } }));
    expect(audit).toHaveLength(5); expect(audit.every(row => row.after && typeof row.after === "object" && !Array.isArray(row.after) && row.after.timezone === statement.timezone)).toBe(true);
    expect(await withTenant(db, f.org, tx => tx.roleAssignment.count({ where: { userAccountId: f.account.id } }))).toBe(0);
  });
  it("uses the configured financial civil day for owner-portal opening and movements", async () => {
    const f = await fixture(); await append(f, "MAD", "0.07", "2026-11-01T23:30:00Z"); const original = await facts(f.org);
    const statement = await getOwnerStatement(f.ctx, f.property.id, { from: "2026-11-02", to: "2026-11-02" }, { db, requestId: randomUUID() });
    expect(statement.timezone).toBe("Europe/Paris"); expect(statement.periodStart.toISOString()).toBe("2026-11-01T23:00:00.000Z");
    expect(statement.openingBalance.toJSON().amount).toBe("0.00"); expect(statement.periodCreditTotal.toJSON().amount).toBe("0.07");
    expect(statement.closingBalance.toJSON().amount).toBe("0.07"); expect(statement.lines).toHaveLength(1);
    const postings = await withTenant(db, f.org, tx => new OwnerStatementRepository(tx, f.org).listOwnerLedgerPostings({ ownerId: f.owner.id, propertyId: f.property.id, periodEnd: statement.periodEnd, currency: "MAD" })),
      originalUtcInterpretation = buildOwnerStatement({ organizationId: f.org, ownerId: f.owner.id, ownerName: f.owner.displayName, propertyId: f.property.id, propertyName: f.property.name,
        ...statementPeriodDates({ from: "2026-11-02", to: "2026-11-02" }), currency: "MAD", postings });
    expect(originalUtcInterpretation.openingBalance.toJSON().amount).toBe("0.07"); expect(originalUtcInterpretation.periodCreditTotal.toJSON().amount).toBe("0.00");
    expect(await facts(f.org)).toEqual(original);
  });
  it("preserves the actual configured Casablanca calendar without assuming a fixed offset", async () => {
    const f = await fixture("Africa/Casablanca"); await append(f, "MAD", "0.07", "2026-11-01T23:30:00Z"); const original = await facts(f.org),
      statement = await getOwnerStatement(f.ctx, f.property.id, { from: "2026-11-02", to: "2026-11-02" }, { db, requestId: randomUUID() });
    expect(statement.timezone).toBe("Africa/Casablanca"); expect(statement.periodStart.toISOString()).toBe("2026-11-02T00:00:00.000Z");
    expect(statement.openingBalance.toJSON().amount).toBe("0.07"); expect(statement.periodCreditTotal.toJSON().amount).toBe("0.00");
    expect(statement.closingBalance.toJSON().amount).toBe("0.07"); expect(statement.lines).toHaveLength(0); expect(await facts(f.org)).toEqual(original);
  });
  it("keeps selected EUR large cents separate from original MAD without FX or financial rewrites", async () => {
    const f = await fixture(); await append(f, "EUR", "9007199254740993.07", "2026-11-02T12:00:00Z"); await append(f, "MAD", "0.07", "2026-11-02T12:01:00Z");
    const original = await facts(f.org), input = { from: "2026-11-02", to: "2026-11-02", currency: "EUR" }, statement = await getOwnerStatement(f.ctx, f.property.id, input, { db, requestId: randomUUID() });
    expect(statement.currency).toBe("EUR"); expect(statement.openingBalance.toJSON().amount).toBe("0.00");
    expect(statement.periodCreditTotal.toJSON().amount).toBe("9007199254740993.07"); expect(statement.closingBalance.toJSON().amount).toBe("9007199254740993.07");
    expect(statement.lines).toHaveLength(1); expect(statement.lines[0].amount.toJSON().currency).toBe("EUR"); expect(await facts(f.org)).toEqual(original);
  });
});
