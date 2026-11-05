import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { withTenant } from "@/platform/db/tenant";
import { ConfigRuleRepository } from "@/platform/config/config-rule-repository";
import * as auditWriter from "@/platform/audit/audit-writer";
import { ManualPaymentProvider, BankTransferPaymentProvider, CashPaymentProvider, AirbnbSettlementPaymentProvider } from "@/modules/finance/application/native-payment-providers";
import { paymentMethodPolicyKey, PaymentMethodChangedError, PaymentMethodConfigurationError, PaymentMethodSourceError } from "@/modules/finance/domain/payment-method";
import { reviewGuestDepositReceipt, postGuestDepositReceipt } from "@/modules/finance/application/guest-deposit-service";
import { reviewGuestDepositCashAdmission } from "@/modules/finance/application/guest-deposit-cash-service";
import { GuestDepositAuthorizationError } from "@/modules/finance/domain/guest-deposit";
import { parseAirbnbSettlementCsv } from "@/modules/finance/domain/airbnb-settlement";
import { actualGuestDepositFixture } from "./support/guest-deposit-fixture";
import { actualGuestDepositCashFixture } from "./support/guest-deposit-cash-fixture";
import { actualOtaSettlementFixture } from "./support/ota-settlement-fixture";
import { provisionIntegrationRole } from "./support/database-role";

const url = process.env.TEST_DATABASE_URL; let admin: PrismaClient, db: PrismaClient;
beforeAll(async () => {
  const target = url ? new URL(url) : null;
  if (!target || !["localhost", "127.0.0.1"].includes(target.hostname) || !(target.pathname.startsWith("/alvillas_automation_payment168_") || target.pathname.startsWith("/alvillas_automation_payment169_") || process.env.GITHUB_ACTIONS === "true" && target.pathname === "/alvillas_os")) throw Error("Owned native provider acceptance database required");
  admin = new PrismaClient({ datasourceUrl: url }); await provisionIntegrationRole(admin, "alvillas_ops_tests");
  const restricted = new URL(url!); restricted.username = restricted.password = "alvillas_ops_tests"; db = new PrismaClient({ datasourceUrl: restricted.toString() });
  expect(await db.$queryRaw`SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user`).toEqual([{ rolsuper: false, rolbypassrls: false }]);
  for (const code of ["MAD", "EUR"]) await admin.currency.upsert({ where: { code }, update: {}, create: { code, name: code, minorUnit: 2 } });
});
afterEach(() => vi.restoreAllMocks()); afterAll(async () => { await db?.$disconnect(); await admin?.$disconnect(); });
type Principal = { org: string; account: { id: string } };
const labels = { en: "Actual received payment", fr: "Paiement reçu réel", ar: "دفعة مستلمة فعلية" };
async function definition(f: Principal, adapter: string, key = adapter, enabled = true) {
  return withTenant(db, f.org, tx => new ConfigRuleRepository(tx, f.org).createVersion({ key: paymentMethodPolicyKey, scopeType: "organization", effectiveFrom: new Date("2000-01-01"),
    createdBy: f.account.id, value: { methods: [{ key, labels, adapter, enabled, currencies: ["MAD", "EUR"] }] }, reason: "Explicit actual configured native payment source adapter" }));
}
async function receipt(adapter: "manual" | "bank_transfer") {
  const f = await actualGuestDepositFixture(db, admin); await definition(f, adapter);
  if (adapter === "manual") await withTenant(db, f.org, tx => new ConfigRuleRepository(tx, f.org).createVersion({ key: "finance.guest_deposits", scopeType: "organization", effectiveFrom: new Date("2020-01-01"), createdBy: f.account.id,
    value: { ...f.policy, payment_methods: [...f.policy.payment_methods, { key: "manual", labels }] }, reason: "Explicitly permit the actual original manual receipt method" }));
  const draft = { ...f.receiptInput, method: adapter }, review = await reviewGuestDepositReceipt(f.ctx, draft, { db }),
    command = { ...draft, reviewFingerprint: review.reviewFingerprint, idempotencyKey: randomUUID(), reason: "Record the actual original guest funds once through their configured method" },
    provider = adapter === "manual" ? new ManualPaymentProvider(f.ctx, command, { db }) : new BankTransferPaymentProvider(f.ctx, command, { db });
  return { ...f, command, provider, intent: { source: command.idempotencyKey, amount: command.amount, currency: command.currency } };
}
const facts = (org: string) => withTenant(db, org, tx => tx.$queryRaw<Array<{ kind: string; id: string; xmin: string; body: string }>>`
  SELECT 'journal' AS kind,id::text,xmin::text,to_jsonb(t)::text AS body FROM financial_transaction t WHERE organization_id=${org}::uuid
  UNION ALL SELECT 'posting',id::text,xmin::text,to_jsonb(p)::text FROM posting p WHERE organization_id=${org}::uuid ORDER BY kind,id`);
const accepted = (org: string) => withTenant(db, org, tx => tx.auditLog.count({ where: { action: "finance.payment_method.accepted" } }));

describe("native payment source adapters through the original ledger", () => {
  it.each(["manual", "bank_transfer"] as const)("admits %s funds once under concurrent calls and preserves all original financial bodies", async adapter => {
    const f = await receipt(adapter), original = await facts(f.org), replies = await Promise.all([f.provider.record(f.intent), f.provider.record(f.intent)]);
    expect(replies[0]).toEqual(replies[1]); expect(await accepted(f.org)).toBe(1);
    const after = await facts(f.org), ids = new Set(original.map(row => row.kind + row.id)); expect(after.filter(row => ids.has(row.kind + row.id))).toEqual(original);
    expect(await withTenant(db, f.org, tx => tx.financialTransaction.count({ where: { reference: "GUEST_DEPOSIT:" + f.command.idempotencyKey } }))).toBe(1);
    expect(await withTenant(db, f.org, tx => tx.auditLog.count({ where: { action: "finance.guest_deposit.received" } }))).toBe(1);
  });
  it("recovers the original method identity after its definition is disabled without rewriting history", async () => {
    const f = await receipt("bank_transfer"), first = await f.provider.record(f.intent), original = await facts(f.org); await definition(f, "bank_transfer", "bank_transfer", false);
    expect(await f.provider.record(f.intent)).toEqual(first); expect(await accepted(f.org)).toBe(1); expect(await facts(f.org)).toEqual(original);
  });
  it("rejects changed expected money or source before creating a financial movement", async () => {
    const f = await receipt("manual"), original = await facts(f.org);
    await expect(f.provider.record({ ...f.intent, amount: "0.08" })).rejects.toThrow(PaymentMethodSourceError);
    await expect(f.provider.record({ ...f.intent, source: randomUUID() })).rejects.toThrow(PaymentMethodSourceError);
    expect(await facts(f.org)).toEqual(original); expect(await accepted(f.org)).toBe(0);
  });
  it("cannot expand the original held capability by mutating the caller after provider construction", async () => {
    const f = await receipt("manual"), original = await facts(f.org), restricted = { ...f.ctx, authContext: { ...f.ctx.authContext,
      permissions: new Set([...f.ctx.authContext.permissions].filter(key => key !== "financial_transaction:create")) } }, provider = new ManualPaymentProvider(restricted, f.command, { db });
    restricted.authContext.permissions.add("financial_transaction:create");
    await expect(provider.record(f.intent)).rejects.toThrow(GuestDepositAuthorizationError); expect(await accepted(f.org)).toBe(0); expect(await facts(f.org)).toEqual(original);
  });
  it("denies a newly disabled method before any ledger effect can commit", async () => {
    const f = await receipt("manual"), original = await facts(f.org); await definition(f, "manual", "manual", false);
    await expect(f.provider.record(f.intent)).rejects.toThrow(PaymentMethodConfigurationError); expect(await facts(f.org)).toEqual(original); expect(await accepted(f.org)).toBe(0);
  });
  it("rolls back the new journal and its receipts when the method changes during the original producer", async () => {
    const f = await receipt("bank_transfer"), original = await facts(f.org), write = auditWriter.writeAuditEvent;
    vi.spyOn(auditWriter, "writeAuditEvent").mockImplementation(async (tx, event) => { const saved = await write(tx, event); if (event.action === "finance.guest_deposit.received") await definition(f, "bank_transfer", "bank_transfer", false); return saved; });
    await expect(f.provider.record(f.intent)).rejects.toThrow(PaymentMethodChangedError); expect(await facts(f.org)).toEqual(original); expect(await accepted(f.org)).toBe(0);
  });
  it("rechecks original source authority after method admission and rolls back on native revocation", async () => {
    const f = await receipt("manual"), original = await facts(f.org), write = auditWriter.writeAuditEvent;
    vi.spyOn(auditWriter, "writeAuditEvent").mockImplementation(async (tx, event) => { const saved = await write(tx, event); if (event.action === "finance.payment_method.accepted") await withTenant(db, f.org, inner => inner.roleAssignment.update({ where: { id: f.grant.id }, data: { archivedAt: new Date() } })); return saved; });
    await expect(f.provider.record(f.intent)).rejects.toThrow(GuestDepositAuthorizationError); expect(await facts(f.org)).toEqual(original); expect(await accepted(f.org)).toBe(0);
  });
  it("does not retroactively attach a provider definition to a receipt admitted through an older path", async () => {
    const f = await receipt("bank_transfer"); await postGuestDepositReceipt(f.ctx, f.command, { db }); const original = await facts(f.org);
    await expect(f.provider.record(f.intent)).rejects.toThrow(PaymentMethodSourceError); expect(await accepted(f.org)).toBe(0); expect(await facts(f.org)).toEqual(original);
  });
  it("admits original field cash ownership without counting its physical custody a second time", async () => {
    const f = await actualGuestDepositCashFixture(db, admin); await definition(f, "cash");
    const draft = { collectionId: f.cash.id, reservationId: f.reservationId, kind: "stay", amount: "0.07", currency: "MAD", purpose: "Admit the actual original guest cash source" }, review = await reviewGuestDepositCashAdmission(f.ctx, draft, { db }),
      command = { ...draft, reviewFingerprint: review.reviewFingerprint, idempotencyKey: randomUUID(), reason: "Transfer original cash claims without another physical money receipt" },
      provider = new CashPaymentProvider(f.ctx, "cash", command, { db }), intent = { source: command.idempotencyKey, amount: command.amount, currency: command.currency }, original = await facts(f.org), first = await provider.record(intent);
    expect(await provider.record(intent)).toEqual(first); expect(await accepted(f.org)).toBe(1);
    const postings = await withTenant(db, f.org, tx => tx.posting.findMany({ where: { transactionId: first.paymentId }, include: { ledgerAccount: true } }));
    expect(postings).toHaveLength(2); expect(postings.every(row => row.ledgerAccount.accountType === "CLAIM_OWNERSHIP")).toBe(true);
    const ids = new Set(original.map(row => row.kind + row.id)); expect((await facts(f.org)).filter(row => ids.has(row.kind + row.id))).toEqual(original);
  });
  it("uses the actual original Airbnb settlement producer and replays its receipt without another journal", async () => {
    const f = await actualOtaSettlementFixture(db, admin); await definition(f, "airbnb_settlement"); const row = parseAirbnbSettlementCsv(f.input.csv)[0],
      provider = new AirbnbSettlementPaymentProvider(f.ctx, "airbnb_settlement", f.input, f.deps), intent = { source: row.sourceTransactionId, amount: row.actualReceipt, currency: row.currency }, first = await provider.record(intent), original = await facts(f.org);
    expect(await provider.record(intent)).toEqual(first); expect(await accepted(f.org)).toBe(1); expect(await facts(f.org)).toEqual(original);
    expect(await withTenant(db, f.org, tx => tx.airbnbSettlement.count({ where: { sourceTransactionId: row.sourceTransactionId } }))).toBe(1);
  });
});
