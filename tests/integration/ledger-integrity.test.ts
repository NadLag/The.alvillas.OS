import { randomUUID } from "node:crypto";
import { PrismaClient, type Prisma } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { withTenant } from "@/platform/db/tenant";
import { ensureStandardIdentitySetup, startTotpEnrollment, confirmTotpEnrollment } from "@/modules/identity/application/identity-service";
import { identityActorContextFromSession } from "@/modules/identity/application/identity-access";
import { totpCode } from "@/platform/auth/totp";
import { ConfigRuleRepository } from "@/platform/config/config-rule-repository";
import { financialRuleSourceChecks } from "@/platform/config/financial-rule-authority";
import { FinanceRepository } from "@/modules/finance/infrastructure/finance-repository";
import { LedgerIntegrityRepository } from "@/modules/finance/infrastructure/ledger-integrity-repository";
import { scheduleLedgerIntegrity, tickLedgerIntegrity, LedgerIntegrityAccessError, LedgerIntegrityConfigurationError, LedgerIntegritySourceChangedError } from "@/modules/finance/application/ledger-integrity-service";
import { ledgerIntegrityPolicyKey, ledgerIntegrityRoutingKey } from "@/modules/finance/domain/ledger-integrity";
import { Money } from "@/platform/money/money";
import { provisionIntegrationRole } from "./support/database-role";
import { actualBankReconciliationFixture } from "./support/bank-reconciliation-fixture";
import { matchBankStatement, reviewBankReconciliation } from "@/modules/finance/application/bank-reconciliation-service";
import { guestDepositCommandKey } from "@/modules/finance/infrastructure/guest-deposit-repository";
import { NotificationRepository } from "@/platform/notifications/notification-repository";
import { resolveNotificationChannel, channelPayloadSchema } from "@/platform/notifications/notification-channel-service";
import { ledgerIntegrityNoticeKey } from "@/modules/finance/domain/ledger-integrity-notification";
import { deliverEmail } from "@/platform/notifications/email-delivery-service";
import type { EmailProvider } from "@/platform/providers";
import { authContextForAccountInTransaction } from "@/platform/authz/account-context";
import { getNotificationRouting, saveNotificationRouting } from "@/platform/notifications/notification-service";

const url = process.env.TEST_DATABASE_URL; let admin: PrismaClient, db: PrismaClient;
beforeAll(async () => {
  const target = url ? new URL(url) : null;
  if (!target || !["127.0.0.1", "localhost"].includes(target.hostname) || !(target.pathname.startsWith("/alvillas_automation_integrity166_") || target.pathname.startsWith("/alvillas_automation_integrity167_") || process.env.GITHUB_ACTIONS === "true" && target.pathname === "/alvillas_os")) throw Error("Dedicated native integrity acceptance database required");
  admin = new PrismaClient({ datasourceUrl: url }); await provisionIntegrationRole(admin, "alvillas_ops_tests");
  const restricted = new URL(url!); restricted.username = restricted.password = "alvillas_ops_tests"; db = new PrismaClient({ datasourceUrl: restricted.toString() });
  expect(await db.$queryRaw`SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user`).toEqual([{ rolsuper: false, rolbypassrls: false }]);
  for (const code of ["MAD", "EUR"]) await admin.currency.upsert({ where: { code }, update: {}, create: { code, name: code, minorUnit: 2 } });
});
afterAll(async () => { vi.restoreAllMocks(); await db?.$disconnect(); await admin?.$disconnect(); });

async function fixture(options: { routing?: boolean } = {}) {
  const org = randomUUID(); await admin.organization.create({ data: { id: org, name: "Actual retained nightly integrity", baseCurrency: "MAD" } });
  await ensureStandardIdentitySetup(org, { db });
  const result = await withTenant(db, org, async tx => {
    const person = await tx.person.create({ data: { organizationId: org, displayName: "Actual configured integrity principal" } }), account = await tx.userAccount.create({ data: { organizationId: org, personId: person.id, mfaRequired: true, email: "integrity-" + randomUUID() + "@example.test" } }),
      role = await tx.role.create({ data: { organizationId: org, key: "actual_integrity_reader", name: "Explicit complete integrity authority" } }),
      keys = [...new Set(["config_rule:configure", "config_rule:view", "audit_log:view", ...financialRuleSourceChecks(org, ledgerIntegrityPolicyKey).map(check => check.resource.type + ":" + check.action)])],
      permissions = await tx.permission.findMany({ where: { organizationId: org, key: { in: keys } } });
    expect(permissions).toHaveLength(keys.length);
    await tx.rolePermission.createMany({ data: permissions.map(permission => ({ organizationId: org, roleId: role.id, permissionId: permission.id })) });
    const grant = await tx.roleAssignment.create({ data: { organizationId: org, roleId: role.id, userAccountId: account.id, personId: person.id, scopeType: "organization", validFrom: new Date("2000-01-01") } }),
      rules = new ConfigRuleRepository(tx, org);
    await rules.createVersion({ key: "finance.accounting_periods", scopeType: "organization", effectiveFrom: new Date("2000-01-01"), createdBy: account.id,
      value: { timezone: "UTC", allow_early_close: false, max_reopen_seconds: 60 }, reason: "Explicit native integrity calendar" });
    const policy = await rules.createVersion({ key: ledgerIntegrityPolicyKey, scopeType: "organization", effectiveFrom: new Date("2000-01-01"), createdBy: account.id,
      value: { run_at: "00:00", page_size: 50, max_findings: 10, account_types: { locations: ["ASSET_LOCATION"], claims: ["CLAIM_OWNERSHIP"], company: ["ALVILLAS_OWN"] } }, reason: "Explicit native nightly integrity policy" }),
      finance = new FinanceRepository(tx, org), bank = await finance.ensureLedgerAccount({ code: "ORIGINAL_INTEGRITY_BANK", name: "Original custody", accountType: "ASSET_LOCATION", normalSide: "DEBIT" }),
      income = await finance.ensureLedgerAccount({ code: "ORIGINAL_INTEGRITY_INCOME", name: "Original income", accountType: "ALVILLAS_OWN", normalSide: "CREDIT" });
    for (const [currency, value] of [["MAD", "0.07"], ["EUR", "9007199254740993.07"]]) {
      const amount = Money.of(value, currency); await finance.createFinancialTransaction({ reference: "ORIGINAL:" + currency, description: "Original native integrity source", occurredAt: new Date("2020-05-02T12:00:00Z"), createdBy: account.id,
        idempotencyKey: randomUUID(), postings: [{ ledgerAccountId: bank.id, side: "DEBIT", amount, bucket: "COMPANY_REVENUE", dimensions: {} }, { ledgerAccountId: income.id, side: "CREDIT", amount, bucket: "COMPANY_REVENUE", dimensions: {} }] });
    }
    if (options.routing !== false) await rules.createVersion({ key: ledgerIntegrityRoutingKey, scopeType: "organization", effectiveFrom: new Date("2000-01-01"), createdBy: account.id,
      value: { roles: [], people: [person.id], assigned: false, channels: ["in_app", "email"] }, reason: "Explicit actual financial integrity failure audience" });
    return { org, account, grant, policy, bank, income };
  });
  await enroll(result.org, result.account);
  return result;
}

async function enroll(organizationId: string, account: { id: string; personId: string }) {
  const ctx = await identityActorContextFromSession({ user: { id: account.id, personId: account.personId, organizationId, preferredLocale: "en",
    sessionId: randomUUID(), sessionRevoked: false, securitySetupRequired: true }, expires: new Date(Date.now() + 3600000).toISOString() }, { db });
  if (!ctx) throw Error("Expected actual own-factor enrollment context");
  const pending = await startTotpEnrollment(ctx, { db });
  await confirmTotpEnrollment(ctx, pending.credentialId, totpCode(pending.secret), { db });
}
const facts = (org: string) => withTenant(db, org, tx => tx.$queryRaw<Array<{ kind: string; id: string; xmin: string; body: string }>>`
  SELECT 'journal' AS kind,id::text,xmin::text,to_jsonb(t)::text AS body FROM financial_transaction t WHERE organization_id=${org}::uuid
  UNION ALL SELECT 'posting',id::text,xmin::text,to_jsonb(p)::text FROM posting p WHERE organization_id=${org}::uuid ORDER BY kind,id`);

async function failIntegrity(org: string) {
  const method = Object.getOwnPropertyDescriptor(LedgerIntegrityRepository.prototype, "accounts")!.value as LedgerIntegrityRepository["accounts"],
    spy = vi.spyOn(LedgerIntegrityRepository.prototype, "accounts").mockImplementation(async function (this: LedgerIntegrityRepository) {
      return (await method.call(this)).map((row, index) => index ? row : { ...row, debits: Money.of(row.debits, row.currency).add(Money.of("0.01", row.currency)).toJSON().amount });
    });
  try { return await scheduleLedgerIntegrity(org, { db }); } finally { spy.mockRestore(); }
}

describe("actual native nightly ledger integrity", () => {
  it("rebuilds exact currencies, retains verified source hashes and admits only one daily occurrence", async () => {
    const f = await fixture(), original = await facts(f.org), first = await scheduleLedgerIntegrity(f.org, { db });
    expect(first).toMatchObject({ configured: true, passed: true }); expect(first.runId).toBeTruthy();
    expect(await scheduleLedgerIntegrity(f.org, { db })).toEqual(first);
    const retained = await withTenant(db, f.org, async tx => ({ runs: await tx.ledgerIntegrityRun.findMany(), sources: await tx.ledgerIntegritySource.findMany(), audits: await tx.auditLog.count({ where: { action: "finance.ledger_integrity.passed" } }) }));
    expect(retained.runs).toHaveLength(1); expect(retained.sources).toHaveLength(2); expect(retained.audits).toBe(1);
    expect(retained.runs[0].report).toMatchObject({ passed: true, movements: "4", failureCount: "0", currencies: [
      { currency: "EUR", locations: "9007199254740993.07", claims: "0.00", company: "9007199254740993.07" }, { currency: "MAD", locations: "0.07", claims: "0.00", company: "0.07" }] });
    expect(await facts(f.org)).toEqual(original);
  });
  it("deduplicates concurrent native admissions without duplicate audit or financial writes", async () => {
    const f = await fixture(), original = await facts(f.org), results = await Promise.all([scheduleLedgerIntegrity(f.org, { db }), scheduleLedgerIntegrity(f.org, { db })]);
    expect(results[0]).toEqual(results[1]); expect(results[0].passed).toBe(true);
    expect(await withTenant(db, f.org, tx => tx.ledgerIntegrityRun.count())).toBe(1); expect(await facts(f.org)).toEqual(original);
  });
  it("enforces tenant isolation for native receipts and source hashes", async () => {
    const a = await fixture(), b = await fixture(); await scheduleLedgerIntegrity(b.org, { db });
    expect(await withTenant(db, a.org, tx => tx.ledgerIntegrityRun.findMany({ where: { organizationId: b.org } }))).toEqual([]);
    expect(await withTenant(db, a.org, tx => tx.ledgerIntegritySource.findMany({ where: { organizationId: b.org } }))).toEqual([]);
    const source = await withTenant(db, b.org, tx => tx.ledgerIntegritySource.findFirstOrThrow());
    await expect(withTenant(db, a.org, tx => tx.ledgerIntegritySource.create({ data: { organizationId: b.org, transactionId: source.transactionId, fingerprint: source.fingerprint } }))).rejects.toThrow();
  });
  it("rejects forged baselines and retains append-only native verification history", async () => {
    const f = await fixture(), original = await facts(f.org), journal = await withTenant(db, f.org, tx => tx.financialTransaction.findFirstOrThrow());
    await expect(withTenant(db, f.org, tx => tx.ledgerIntegritySource.create({ data: { organizationId: f.org, transactionId: journal.id, fingerprint: "0".repeat(64) } }))).rejects.toThrow(/baseline must match/);
    const result = await scheduleLedgerIntegrity(f.org, { db });
    const metadata = () => withTenant(db, f.org, tx => tx.$queryRaw<Array<{ kind: string; id: string; xmin: string; body: string }>>`
      SELECT 'run' AS kind,id::text,xmin::text,to_jsonb(r)::text AS body FROM ledger_integrity_run r WHERE organization_id=${f.org}::uuid
      UNION ALL SELECT 'source',transaction_id::text,xmin::text,to_jsonb(s)::text FROM ledger_integrity_source s WHERE organization_id=${f.org}::uuid ORDER BY kind,id`), before = await metadata();
    await expect(withTenant(db, f.org, tx => tx.ledgerIntegrityRun.update({ where: { id: result.runId! }, data: { passed: false } }))).rejects.toThrow(/ledger rows are append-only/);
    await expect(withTenant(db, f.org, tx => tx.ledgerIntegritySource.update({ where: { organizationId_transactionId: { organizationId: f.org, transactionId: journal.id } }, data: { fingerprint: "0".repeat(64) } }))).rejects.toThrow(/ledger rows are append-only/);
    expect(await metadata()).toEqual(before);
    expect(await facts(f.org)).toEqual(original);
  });
  it("rolls back receipts, baselines and audit when the configured principal is revoked after recording", async () => {
    const f = await fixture(), original = await facts(f.org), method = Object.getOwnPropertyDescriptor(LedgerIntegrityRepository.prototype, "record")!.value as LedgerIntegrityRepository["record"],
      spy = vi.spyOn(LedgerIntegrityRepository.prototype, "record").mockImplementation(async function (this: LedgerIntegrityRepository, input) {
        const result = await method.call(this, input); await withTenant(db, f.org, tx => tx.roleAssignment.update({ where: { id: f.grant.id }, data: { archivedAt: new Date() } })); return result;
      });
    try { await expect(scheduleLedgerIntegrity(f.org, { db })).rejects.toBeInstanceOf(LedgerIntegrityAccessError); } finally { spy.mockRestore(); }
    expect(await withTenant(db, f.org, tx => tx.ledgerIntegrityRun.count())).toBe(0); expect(await withTenant(db, f.org, tx => tx.ledgerIntegritySource.count())).toBe(0);
    expect(await withTenant(db, f.org, tx => tx.auditLog.count({ where: { action: { startsWith: "finance.ledger_integrity." } } }))).toBe(0); expect(await facts(f.org)).toEqual(original);
  });
  it("retains a real failed receipt for a mismatched independent total without changing source money", async () => {
    const f = await fixture(), original = await facts(f.org), method = Object.getOwnPropertyDescriptor(LedgerIntegrityRepository.prototype, "accounts")!.value as LedgerIntegrityRepository["accounts"],
      spy = vi.spyOn(LedgerIntegrityRepository.prototype, "accounts").mockImplementation(async function (this: LedgerIntegrityRepository) {
        const rows = await method.call(this); return rows.map((row, index) => index ? row : { ...row, debits: Money.of(row.debits, row.currency).add(Money.of("0.01", row.currency)).toJSON().amount });
      });
    let runId: string | null;
    try { const result = await scheduleLedgerIntegrity(f.org, { db }); expect(result.passed).toBe(false); runId = result.runId; } finally { spy.mockRestore(); }
    const row = await withTenant(db, f.org, tx => tx.ledgerIntegrityRun.findUniqueOrThrow({ where: { id: runId! } }));
    expect(row.report).toMatchObject({ passed: false, failureCount: "1", findings: [{ code: "ACCOUNT_BALANCE" }] });
    expect(await withTenant(db, f.org, tx => tx.ledgerIntegritySource.count())).toBe(0); expect(await facts(f.org)).toEqual(original);
  });
  it("rejects a changed final native snapshot before any retained result escapes", async () => {
    const f = await fixture(), original = await facts(f.org), spy = vi.spyOn(LedgerIntegrityRepository.prototype, "snapshotMatches").mockResolvedValue(false);
    try { await expect(scheduleLedgerIntegrity(f.org, { db })).rejects.toBeInstanceOf(LedgerIntegritySourceChangedError); } finally { spy.mockRestore(); }
    expect(await withTenant(db, f.org, tx => tx.ledgerIntegrityRun.count())).toBe(0); expect(await facts(f.org)).toEqual(original);
  });
  it("does not fabricate a nightly policy or a financial principal for an unconfigured tenant", async () => {
    const org = randomUUID(); await admin.organization.create({ data: { id: org, name: "Explicitly unconfigured integrity tenant", baseCurrency: "MAD" } });
    expect(await scheduleLedgerIntegrity(org, { db })).toEqual({ configured: false, runId: null, passed: null });
    expect(await withTenant(db, org, tx => tx.ledgerIntegrityRun.count())).toBe(0);
  });
  it("checks every original movement across 500 real properties with exact large cents and retained history", async () => {
    const f = await fixture(), properties = Array.from({ length: 500 }, () => ({ id: randomUUID(), organizationId: f.org, name: "Actual integrity villa", addressLine1: "Native acceptance", city: "Marrakech", propertyType: "VILLA", bedrooms: 1, bathrooms: 1, maxGuests: 2, amenities: [] as string[], photoUrls: [] as string[] }));
    await withTenant(db, f.org, async tx => {
      await tx.property.createMany({ data: properties }); const finance = new FinanceRepository(tx, f.org), amount = Money.of("9007199254740993.07", "EUR");
      for (const property of properties) await finance.createFinancialTransaction({ reference: "ACTUAL-500:" + property.id, description: "Actual large native source across 500 properties", occurredAt: new Date("2020-05-03T12:00:00Z"), createdBy: f.account.id, idempotencyKey: randomUUID(),
        postings: [{ ledgerAccountId: f.bank.id, side: "DEBIT", amount, bucket: "COMPANY_REVENUE", dimensions: { property_id: property.id } }, { ledgerAccountId: f.income.id, side: "CREDIT", amount, bucket: "COMPANY_REVENUE", dimensions: { property_id: property.id } }] });
    });
    const original = await facts(f.org), result = await scheduleLedgerIntegrity(f.org, { db }); expect(result.passed).toBe(true);
    const receipt = await withTenant(db, f.org, tx => tx.ledgerIntegrityRun.findUniqueOrThrow({ where: { id: result.runId! } }));
    expect(receipt.report).toMatchObject({ movements: "1004", failureCount: "0", currencies: [{ currency: "EUR", locations: Money.of("9007199254740993.07", "EUR").multiply("501").toJSON().amount }, { currency: "MAD", locations: "0.07" }] });
    expect(await withTenant(db, f.org, tx => tx.ledgerIntegritySource.count())).toBe(502); expect(await facts(f.org)).toEqual(original);
  });
  it("checks real admitted guest receipts and matched bank facts through their original tenant-bound sources", async () => {
    const f = await actualBankReconciliationFixture(db, admin), input = { action: "MATCH" as const, accountId: f.banks.receipt.id, currency: "MAD",
      expected: [{ id: f.posting.id, amount: "0.07" }], actual: f.lines.map(line => ({ id: line.id, amount: line.amount!.toFixed(2) })), reason: "Actual source integrity acceptance", varianceAction: null },
      review = await reviewBankReconciliation(f.ctx, input, f.deps);
    await matchBankStatement(f.ctx, { ...input, reviewFingerprint: String(review.reviewFingerprint), idempotencyKey: randomUUID() }, f.deps);
    await withTenant(db, f.org, async tx => {
      const keys = [...new Set(["config_rule:configure", "config_rule:view", "audit_log:view", ...financialRuleSourceChecks(f.org, ledgerIntegrityPolicyKey).map(check => check.resource.type + ":" + check.action)])],
        permissions = await tx.permission.findMany({ where: { organizationId: f.org, key: { in: keys } } }); expect(permissions).toHaveLength(keys.length);
      await tx.rolePermission.createMany({ data: permissions.map(permission => ({ organizationId: f.org, roleId: f.role.id, permissionId: permission.id })), skipDuplicates: true });
      await new ConfigRuleRepository(tx, f.org).createVersion({ key: ledgerIntegrityPolicyKey, scopeType: "organization", effectiveFrom: new Date("2000-01-01"), createdBy: f.account.id,
        value: { run_at: "00:00", page_size: 50, max_findings: 10, account_types: { locations: ["ASSET_LOCATION", "ASSET", "STAFF_WALLET"], claims: ["CLAIM_OWNERSHIP"], company: ["ALVILLAS_OWN"] } }, reason: "Explicit actual guest and bank integrity sources" });
      await new ConfigRuleRepository(tx, f.org).createVersion({ key: ledgerIntegrityRoutingKey, scopeType: "organization", effectiveFrom: new Date("2000-01-01"), createdBy: f.account.id,
        value: { roles: [], people: [f.account.personId], assigned: false, channels: ["in_app", "email"] }, reason: "Explicit complete-source failure audience" });
    });
    await enroll(f.org, f.account);
    const original = await facts(f.org), bankFacts = () => withTenant(db, f.org, tx => tx.$queryRaw<Array<{ kind: string; id: string; xmin: string; body: string }>>`
      SELECT 'line' AS kind,id::text,xmin::text,to_jsonb(b)::text AS body FROM bank_statement_line b WHERE organization_id=${f.org}::uuid
      UNION ALL SELECT 'allocation',id::text,xmin::text,to_jsonb(a)::text FROM bank_reconciliation_allocation a WHERE organization_id=${f.org}::uuid ORDER BY kind,id`), retained = await bankFacts();
    expect(await scheduleLedgerIntegrity(f.org, { db })).toMatchObject({ passed: true }); expect(await facts(f.org)).toEqual(original); expect(await bankFacts()).toEqual(retained);
  });
  it("preserves native complete-source rejection for a forged foreign-deposit journal", async () => {
    const f = await fixture(), foreign = await actualBankReconciliationFixture(db, admin);
    const foreignOriginal = await withTenant(db, foreign.org, tx => tx.financialTransaction.findUniqueOrThrow({ where: { id: foreign.receipt.id }, select: { idempotencyKey: true } }));
    expect(foreignOriginal.idempotencyKey).toMatch(/^guest-deposit:/u);
    const foreignCommand = foreignOriginal.idempotencyKey!.slice(guestDepositCommandKey("").length);
    const original = await facts(f.org), foreignFacts = await facts(foreign.org);
    await expect(withTenant(db, f.org, async tx => {
      const finance = new FinanceRepository(tx, f.org), amount = Money.of("0.07", "MAD"), dimensions = { deposit_id: foreignCommand };
      await finance.createFinancialTransaction({ reference: "INVALID-FOREIGN-DIMENSION:" + randomUUID(), description: "Isolated original negative acceptance fixture", occurredAt: new Date("2020-05-04T12:00:00Z"), createdBy: f.account.id, idempotencyKey: randomUUID(),
        postings: [{ ledgerAccountId: f.bank.id, side: "DEBIT", amount, bucket: "COMPANY_REVENUE", dimensions }, { ledgerAccountId: f.income.id, side: "CREDIT", amount, bucket: "COMPANY_REVENUE", dimensions }] });
    })).rejects.toThrow("guest_deposit_complete_source_required");
    const result = await scheduleLedgerIntegrity(f.org, { db }); expect(result.passed).toBe(true);
    const receipt = await withTenant(db, f.org, tx => tx.ledgerIntegrityRun.findUniqueOrThrow({ where: { id: result.runId! } }));
    expect(receipt.report).toMatchObject({ failureCount: "0", findings: [] });
    expect(JSON.stringify(receipt.report)).not.toContain(foreignCommand); expect(await facts(f.org)).toEqual(original); expect(await facts(foreign.org)).toEqual(foreignFacts);
  });
  it("rejects a native projection with invalid tenant scope while preserving original financial history", async () => {
    const f = await fixture(), original = await facts(f.org), method = Object.getOwnPropertyDescriptor(LedgerIntegrityRepository.prototype, "movements")!.value as LedgerIntegrityRepository["movements"];
    let injected = false;
    const spy = vi.spyOn(LedgerIntegrityRepository.prototype, "movements").mockImplementation(async function (this: LedgerIntegrityRepository, after, limit) {
      const rows = await method.call(this, after, limit); if (injected || !rows.length) return rows; injected = true; return [{ ...rows[0], validScope: false }, ...rows.slice(1)];
    });
    let runId: string | null;
    try { const result = await scheduleLedgerIntegrity(f.org, { db }); expect(result.passed).toBe(false); runId = result.runId; } finally { spy.mockRestore(); }
    const receipt = await withTenant(db, f.org, tx => tx.ledgerIntegrityRun.findUniqueOrThrow({ where: { id: runId! } }));
    expect(receipt.report).toMatchObject({ failureCount: "1", findings: [{ code: "TENANT_DIMENSIONS" }] });
    expect(await withTenant(db, f.org, tx => tx.ledgerIntegritySource.count())).toBe(0); expect(await facts(f.org)).toEqual(original);
  });
  it("atomically delivers one source-bound failed-check inbox receipt and configured email request", async () => {
    const f = await fixture(), original = await facts(f.org), result = await failIntegrity(f.org);
    expect(result.passed).toBe(false);
    const saved = await withTenant(db, f.org, async tx => ({ notices: await tx.notification.findMany({ where: { kind: "ledger_integrity_failed" } }),
      source: await tx.outboxEvent.findUniqueOrThrow({ where: { organizationId_idempotencyKey: { organizationId: f.org, idempotencyKey: ledgerIntegrityNoticeKey(result.runId!, f.account.id) } } }),
      channels: await tx.outboxEvent.findMany({ where: { type: "notification.channel.requested" } }) }));
    expect(saved.notices).toHaveLength(1); expect(saved.notices[0]).toMatchObject({ recipientId: f.account.id, eventId: saved.source.id, targetId: saved.source.id });
    expect(saved.source.status).toBe("DISPATCHED"); expect(saved.channels).toHaveLength(1);
    const payload = channelPayloadSchema.parse(saved.channels[0].payload);
    expect(payload).toMatchObject({ channel: "email", kind: "ledger_integrity_failed", recipientId: f.account.id, sourceEventId: saved.source.id });
    const delivery = await withTenant(db, f.org, tx => resolveNotificationChannel(new NotificationRepository(tx, f.org), payload));
    expect(delivery).toMatchObject({ allowed: true, destination: "/en/app/audit" });
    expect((await withTenant(db, f.org, tx => resolveNotificationChannel(new NotificationRepository(tx, f.org), { ...payload, channel: "push" }))).allowed).toBe(false);
    expect((await withTenant(db, f.org, tx => resolveNotificationChannel(new NotificationRepository(tx, f.org), { ...payload, sourceEventId: randomUUID() }))).allowed).toBe(false);
    const sent: Parameters<EmailProvider["send"]>[0][] = [];
    await deliverEmail(saved.channels[0], { db, env: { APP_URL: "http://localhost:3000", EMAIL_FROM: "local-acceptance@example.test" },
      provider: { send: input => { sent.push(input); return Promise.resolve({ id: "actual-local-provider-ack" }); } } });
    expect(sent).toHaveLength(1); expect(sent[0]).toMatchObject({ to: f.account.email, template: "notification.system" });
    expect(sent[0].text).toContain("http://localhost:3000/en/app/audit");
    expect(sent[0].text).not.toContain("9007199254740993.07");
    expect(await withTenant(db, f.org, tx => tx.notificationDelivery.findFirstOrThrow({ where: { eventId: saved.channels[0].id } }))).toMatchObject({ status: "ACCEPTED", attemptCount: 1 });
    expect(await scheduleLedgerIntegrity(f.org, { db })).toEqual(result);
    expect(await withTenant(db, f.org, tx => tx.notification.count({ where: { kind: "ledger_integrity_failed" } }))).toBe(1);
    expect(await facts(f.org)).toEqual(original);
  });
  it.each(["grant", "mfa", "routing"] as const)("suppresses retained failure destinations and external delivery after current %s revocation", async change => {
    const f = await fixture(), original = await facts(f.org); await failIntegrity(f.org);
    const event = await withTenant(db, f.org, tx => tx.outboxEvent.findFirstOrThrow({ where: { type: "notification.channel.requested" } })), payload = channelPayloadSchema.parse(event.payload);
    await withTenant(db, f.org, async tx => {
      if (change === "grant") await tx.roleAssignment.update({ where: { id: f.grant.id }, data: { archivedAt: new Date() } });
      else if (change === "mfa") await tx.authCredential.updateMany({ where: { userAccountId: f.account.id, type: "TOTP" }, data: { revokedAt: new Date() } });
      else await new ConfigRuleRepository(tx, f.org).createVersion({ key: ledgerIntegrityRoutingKey, scopeType: "organization", effectiveFrom: new Date("2001-01-01"), createdBy: f.account.id,
        value: { roles: [], people: [f.account.personId], assigned: false, channels: ["in_app"] }, reason: "Explicit current financial channel withdrawal" });
    });
    await withTenant(db, f.org, async tx => {
      const repo = new NotificationRepository(tx, f.org), rows = await repo.page(f.account.id);
      expect((await repo.targets(rows, f.account.id)).size).toBe(0);
      expect((await resolveNotificationChannel(repo, payload)).allowed).toBe(false);
    });
    expect(await facts(f.org)).toEqual(original);
  });
  it("blocks an unenrolled configured audience without publishing a false successful check", async () => {
    const f = await fixture(), original = await facts(f.org);
    await withTenant(db, f.org, async tx => {
      const person = await tx.person.create({ data: { organizationId: f.org, displayName: "Actual separate unenrolled audience" } }),
        account = await tx.userAccount.create({ data: { organizationId: f.org, personId: person.id, mfaRequired: true } });
      await tx.roleAssignment.create({ data: { organizationId: f.org, personId: person.id, userAccountId: account.id, roleId: f.grant.roleId,
        scopeType: "organization", validFrom: new Date("2000-01-01") } });
      await new ConfigRuleRepository(tx, f.org).createVersion({ key: ledgerIntegrityRoutingKey, scopeType: "organization", effectiveFrom: new Date("2001-01-01"), createdBy: f.account.id,
        value: { roles: [], people: [person.id], assigned: false, channels: ["in_app", "email"] }, reason: "Actual unenrolled recipient distinct from the configured principal" });
    });
    await expect(scheduleLedgerIntegrity(f.org, { db })).rejects.toBeInstanceOf(LedgerIntegrityConfigurationError);
    expect(await tickLedgerIntegrity(f.org, { db })).toMatchObject({ configured: true, runId: null, passed: null, blocked: "configuration_unavailable" });
    expect(await withTenant(db, f.org, tx => tx.ledgerIntegrityRun.count())).toBe(0); expect(await facts(f.org)).toEqual(original);
  });
  it("rolls back failed receipts, inbox, channel requests and audit when authority is revoked during publication", async () => {
    const f = await fixture(), original = await facts(f.org), method = Object.getOwnPropertyDescriptor(NotificationRepository.prototype, "publishMany")!.value as NotificationRepository["publishMany"],
      spy = vi.spyOn(NotificationRepository.prototype, "publishMany").mockImplementation(async function (this: NotificationRepository, input) {
        await method.call(this, input); await withTenant(db, f.org, tx => tx.roleAssignment.update({ where: { id: f.grant.id }, data: { archivedAt: new Date() } }));
      });
    try { await expect(failIntegrity(f.org)).rejects.toBeInstanceOf(LedgerIntegrityAccessError); } finally { spy.mockRestore(); }
    await withTenant(db, f.org, async tx => {
      expect(await tx.ledgerIntegrityRun.count()).toBe(0); expect(await tx.notification.count({ where: { kind: "ledger_integrity_failed" } })).toBe(0);
      expect(await tx.outboxEvent.count({ where: { type: { in: ["notification.requested", "notification.channel.requested"] } } })).toBe(0);
      expect(await tx.auditLog.count({ where: { action: "finance.ledger_integrity.failed" } })).toBe(0);
    });
    expect(await facts(f.org)).toEqual(original);
  });
  it("rejects fabricated failed-run envelopes, foreign references and extra financial content in native storage", async () => {
    const f = await fixture(), foreign = await fixture(); await failIntegrity(f.org); const passed = await scheduleLedgerIntegrity(foreign.org, { db });
    const source = await withTenant(db, f.org, tx => tx.outboxEvent.findFirstOrThrow({ where: { type: "notification.requested" } })),
      payload = source.payload as Prisma.JsonObject, metadata = payload.integrityNotice as Prisma.JsonObject, original = await facts(f.org);
    for (const integrityNotice of [{ ...metadata, runId: randomUUID() }, { ...metadata, runId: passed.runId }, { ...metadata, privateAmount: "9007199254740993.07" }]) {
      const id = randomUUID(); await expect(withTenant(db, f.org, tx => tx.outboxEvent.create({ data: { id, organizationId: f.org, type: source.type,
        idempotencyKey: source.idempotencyKey, payload: { ...payload, targetId: id, integrityNotice } } }))).rejects.toThrow(/actual tenant failed run/);
    }
    expect(await facts(f.org)).toEqual(original);
  });
  it("retains native source and receipt identities after rejected mutation attempts", async () => {
    const f = await fixture(); await failIntegrity(f.org);
    const source = await withTenant(db, f.org, tx => tx.outboxEvent.findFirstOrThrow({ where: { type: "notification.requested" } })),
      notice = await withTenant(db, f.org, tx => tx.notification.findFirstOrThrow({ where: { kind: "ledger_integrity_failed" } })),
      retained = () => withTenant(db, f.org, tx => tx.$queryRaw<Array<{ kind: string; xmin: string; body: string }>>`
        SELECT 'event' AS kind,xmin::text,to_jsonb(e)::text AS body FROM outbox_event e WHERE organization_id=${f.org}::uuid AND id=${source.id}::uuid
        UNION ALL SELECT 'receipt',xmin::text,to_jsonb(n)::text FROM notification n WHERE organization_id=${f.org}::uuid AND id=${notice.id}::uuid ORDER BY kind`), original = await retained();
    await expect(withTenant(db, f.org, tx => tx.outboxEvent.update({ where: { id: source.id }, data: { payload: { ...(source.payload as Prisma.JsonObject), targetId: randomUUID() } } }))).rejects.toThrow(/source identity is immutable/);
    await expect(withTenant(db, f.org, tx => tx.notification.update({ where: { id: notice.id }, data: { targetId: randomUUID() } }))).rejects.toThrow(/identity is immutable|only the first notification read timestamp/);
    await expect(withTenant(db, f.org, tx => tx.outboxEvent.delete({ where: { id: source.id } }))).rejects.toThrow(/append-only/);
    await expect(withTenant(db, f.org, tx => tx.notification.delete({ where: { id: notice.id } }))).rejects.toThrow(/append-only|cannot be deleted/);
    expect(await retained()).toEqual(original);
  });
  it("preserves the existing native notification kinds and still rejects unsupported ones", async () => {
    const f = await fixture(), event = await withTenant(db, f.org, tx => tx.outboxEvent.create({ data: { organizationId: f.org, type: "notification.requested",
      idempotencyKey: randomUUID(), payload: { kind: "language_updated", recipientId: f.account.id, targetId: f.account.id } } }));
    await expect(withTenant(db, f.org, tx => tx.notification.create({ data: { organizationId: f.org, recipientId: f.account.id, eventId: event.id, targetId: f.account.id, kind: "unapproved_integrity_kind" } }))).rejects.toThrow(/notification_kind_check/);
    expect(await withTenant(db, f.org, tx => tx.notification.create({ data: { organizationId: f.org, recipientId: f.account.id, eventId: event.id, targetId: f.account.id, kind: "language_updated" } }))).toMatchObject({ kind: "language_updated" });
  });
  it("opens an unconfigured failure audience without implicit writes and saves its first explicit route through the canonical writer", async () => {
    const f = await fixture({ routing: false }), original = await facts(f.org), authContext = await withTenant(db, f.org, tx => authContextForAccountInTransaction(tx, f.org, f.account.id)),
      actor = { organizationId: f.org, accountId: f.account.id, authContext }, input = { kind: "ledger_integrity_failed", propertyId: null };
    await expect(scheduleLedgerIntegrity(f.org, { db })).rejects.toBeInstanceOf(LedgerIntegrityConfigurationError);
    expect((await getNotificationRouting(actor, input, { db })).routing).toEqual({ roles: [], people: [], assigned: false, channels: [] });
    expect(await withTenant(db, f.org, tx => tx.configRule.count({ where: { key: ledgerIntegrityRoutingKey } }))).toBe(0);
    const routing = { roles: [], people: [f.account.personId], assigned: false, channels: ["in_app", "email"] };
    expect(await saveNotificationRouting(actor, { ...input, routing, reason: "Configure the first actual financial failure audience" }, { db })).toEqual(routing);
    expect((await getNotificationRouting(actor, input, { db })).routing).toEqual(routing);
    expect(await withTenant(db, f.org, tx => tx.configRule.count({ where: { key: ledgerIntegrityRoutingKey } }))).toBe(1);
    expect(await scheduleLedgerIntegrity(f.org, { db })).toMatchObject({ passed: true }); expect(await facts(f.org)).toEqual(original);
  });
});
