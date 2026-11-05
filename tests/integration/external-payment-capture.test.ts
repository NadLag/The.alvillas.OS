import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { PrismaClient } from "@prisma/client";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { withTenant, type TenantTransactionRunner } from "@/platform/db/tenant";
import { ConfigRuleRepository } from "@/platform/config/config-rule-repository";
import * as auditWriter from "@/platform/audit/audit-writer";
import { requestExternalPaymentCapture, executeExternalPaymentCaptureReference, externalPaymentCaptureRequested } from "@/modules/finance/application/external-payment-service";
import { reviewCapturedPayPalAdmission, getExternalPaymentIntent } from "@/modules/finance/application/external-payment-workspace-service";
import { admitCapturedPayPalPayment } from "@/modules/finance/application/native-paypal-admission";
import { PaymentMethodAccessError, PaymentMethodConfigurationError } from "@/modules/finance/domain/payment-method";
import { inspectGuestDepositReceiptInTransaction, postGuestDepositReceipt } from "@/modules/finance/application/guest-deposit-service";
import { guestPaymentMethodScopes } from "@/modules/finance/application/guest-deposit-payment-method";
import { PaymentMethodRepository } from "@/modules/finance/infrastructure/payment-method-repository";
import { ExternalPaymentRepository } from "@/modules/finance/infrastructure/external-payment-repository";
import { FinanceRepository } from "@/modules/finance/infrastructure/finance-repository";
import { GuestDepositAuthorizationError } from "@/modules/finance/domain/guest-deposit";
import { ExternalPaymentIntentError } from "@/modules/finance/domain/external-payment-intent";
import { actualGuestDepositFixture } from "./support/guest-deposit-fixture";
import { provisionIntegrationRole } from "./support/database-role";

const captureTimes=new Map<string,string>();
function providerReceipt(paymentId:string,amount="0.07"){const capturedAt=captureTimes.get(paymentId)??new Date().toISOString();captureTimes.set(paymentId,capturedAt);return{paymentId,capturedAt,settlement:{schemaVersion:1 as const,basis:"ORIGINAL_PROVIDER_RECEIVABLE_BREAKDOWN" as const,gross:{amount,currency:"MAD"},fee:{amount:"0.00",currency:"MAD"},net:{amount,currency:"MAD"}}};}
let admin: PrismaClient, db: PrismaClient, control: PrismaClient;
beforeAll(async () => {
  const url = process.env.TEST_DATABASE_URL, target = url ? new URL(url) : null;
  if (!target || !["localhost", "127.0.0.1"].includes(target.hostname) || !(target.pathname.startsWith("/alvillas_automation_") || process.env.GITHUB_ACTIONS === "true" && target.pathname === "/alvillas_os")) throw Error("Owned external-capture acceptance database required");
  control = new PrismaClient({ datasourceUrl: url });
  const database = "alvillas_automation_external171_" + randomUUID().replaceAll("-", "").slice(0, 20);
  if (!/^[a-z0-9_]{1,63}$/u.test(database)) throw Error("Owned shadow identifier required");
  await control.$executeRawUnsafe('CREATE DATABASE "' + database + '"'); const shadow = new URL(url!); shadow.pathname = "/" + database;
  execFileSync(process.execPath, ["node_modules/prisma/build/index.js", "migrate", "deploy", "--schema", resolve("prisma/schema.prisma")], { env: { ...process.env, DATABASE_URL: shadow.toString() }, stdio: "pipe" });
  admin = new PrismaClient({ datasourceUrl: shadow.toString() }); await provisionIntegrationRole(admin, "alvillas_ops_tests");
  const restricted = new URL(shadow); restricted.username = restricted.password = "alvillas_ops_tests"; db = new PrismaClient({ datasourceUrl: restricted.toString() });
  expect(await db.$queryRaw`SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user`).toEqual([{ rolsuper: false, rolbypassrls: false }]);
  for (const code of ["MAD", "EUR"]) await admin.currency.upsert({ where: { code }, update: {}, create: { code, name: code, minorUnit: 2 } });
}, 120000);
afterEach(() => vi.restoreAllMocks()); afterAll(async () => { await db?.$disconnect(); await admin?.$disconnect(); await control?.$disconnect(); });
const labels = { en: "Original optional PayPal", fr: "PayPal facultatif initial", ar: "باي بال الاختياري الأصلي" };
async function fixture(amount = "0.07", orderId = "ORDER_" + randomUUID().replaceAll("-", "")) {
  const f = await actualGuestDepositFixture(db, admin, "MAD", 2, amount);
  const merchant = await withTenant(db, f.org, tx => new FinanceRepository(tx, f.org).ensureLedgerAccount({ code: "PAYPAL_MERCHANT_BALANCE", name: "Actual configured PayPal merchant location", accountType: "ASSET_LOCATION", normalSide: "DEBIT" }));
  const input = await withTenant(db, f.org, async tx => {
    const rules = new ConfigRuleRepository(tx, f.org);
    await rules.createVersion({ key: "finance.guest_deposits", scopeType: "organization", effectiveFrom: new Date("2020-01-01"), createdBy: f.account.id,
      value: { ...f.policy, receipt_account_codes: [...f.policy.receipt_account_codes, merchant.code], payment_methods: [...f.policy.payment_methods, { key: "confirmed-paypal", labels }] }, reason: "Explicit original external receipt configuration" });
    await rules.createVersion({ key: "finance.payment_methods", scopeType: "organization", effectiveFrom: new Date("2020-01-01"), createdBy: f.account.id,
      value: { methods: [{ key: "confirmed-paypal", labels, adapter: "paypal", enabled: true, currencies: ["MAD"], provider_account_code: merchant.code }] }, reason: "Explicit optional original PayPal protocol" });
    const receipt = { ...f.receiptInput, accountId: merchant.id, method: "confirmed-paypal", externalReference: orderId }, prepared = await inspectGuestDepositReceiptInTransaction(f.ctx, receipt, tx),
      now = await new FinanceRepository(tx, f.org).clock(), catalog = await new PaymentMethodRepository(tx, f.org).catalog({ at: now, currency: "MAD", scopes: await guestPaymentMethodScopes(tx, f.org, f.reservationId, now) });
    return { provider: "paypal" as const, orderId, receipt: { ...receipt, idempotencyKey: randomUUID(), reason: "Capture only this original reviewed payment without duplicate guest funds", reviewFingerprint: prepared.fingerprint, paymentMethodFingerprint: catalog.identity } };
  });
  return { ...f, banks: { ...f.banks, receipt: merchant }, input };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function reference(f: Fixture, intentId: string) {
  const event = await withTenant(db, f.org, tx => tx.outboxEvent.findFirstOrThrow({ where: { organizationId: f.org, type: externalPaymentCaptureRequested, payload: { path: ["intentId"], equals: intentId } } }));
  return { organizationId: f.org, outboxEventId: event.id };
}
const rows = (org: string) => withTenant(db, org, async tx => ({ intents: await tx.externalPaymentIntent.findMany({ where: { organizationId: org }, include: { capture: true } }), captures: await tx.externalPaymentCapture.findMany({ where: { organizationId: org } }) }));
const moneyFacts = (org: string) => withTenant(db, org, tx => tx.$queryRaw<Array<{ kind: string; id: string; xmin: string; body: string }>>`
  SELECT 'journal' AS kind,id::text,xmin::text,to_jsonb(t)::text AS body FROM financial_transaction t WHERE organization_id=${org}::uuid
  UNION ALL SELECT 'posting',id::text,xmin::text,to_jsonb(p)::text FROM posting p WHERE organization_id=${org}::uuid ORDER BY kind,id`);
describe("durable optional external capture on PostgreSQL", () => {
  it.each(["0.07", "9007199254740993.07"])("retains one exact %s intent, outbox, capture and audit with provider I/O outside every transaction", async amount => {
    const f = await fixture(amount), before = await moneyFacts(f.org); let active = 0;
    const runner: TenantTransactionRunner = { $transaction: (work, options) => db.$transaction(async tx => { active++; try { return await work(tx); } finally { active--; } }, options) };
    const provider = { lookup: vi.fn(() => { expect(active).toBe(0); return Promise.resolve({ state: "APPROVED" as const }); }), capture: vi.fn((input: { source: string; amount: string; currency: string }) => { expect(active).toBe(0); expect(input).toEqual({ source: f.input.orderId, amount, currency: "MAD" }); return Promise.resolve(providerReceipt("CAPTURE_" + randomUUID(), input.amount)); }) };
    const request = await requestExternalPaymentCapture(f.ctx, f.input, { db: runner }), ref = await reference(f, request.id);
    expect(request.state).toBe("PENDING"); const captured = await executeExternalPaymentCaptureReference(ref, { db: runner, provider });
    expect(captured).toMatchObject({ state: "CAPTURED", amount: { amount, currency: "MAD" }, idempotent: false });
    expect(await executeExternalPaymentCaptureReference(ref, { db: runner, provider })).toEqual({ ...captured, idempotent: true });
    expect(provider.capture).toHaveBeenCalledTimes(1); expect(provider.lookup).toHaveBeenCalledTimes(1);
    const saved = await rows(f.org); expect(saved.intents).toHaveLength(1); expect(saved.captures).toHaveLength(1); expect(saved.captures[0].amount.toFixed(2)).toBe(amount);
    expect(await moneyFacts(f.org)).toEqual(before);
    expect(await withTenant(db, f.org, tx => tx.auditLog.count({ where: { organizationId: f.org, action: "finance.external_payment.captured" } }))).toBe(1);
  });
  it("deduplicates concurrent original intent requests without another capture task", async () => {
    const f = await fixture(), outcomes = await Promise.all(Array.from({ length: 4 }, () => requestExternalPaymentCapture(f.ctx, f.input, { db })));
    expect(new Set(outcomes.map(outcome => outcome.id)).size).toBe(1); expect(outcomes.filter(outcome => !outcome.idempotent)).toHaveLength(1);
    expect(await withTenant(db, f.org, tx => tx.outboxEvent.count({ where: { organizationId: f.org, type: externalPaymentCaptureRequested } }))).toBe(1);
  });
  it("recovers a lost capture acknowledgement through GET before another POST", async () => {
    const f = await fixture(), request = await requestExternalPaymentCapture(f.ctx, f.input, { db }), ref = await reference(f, request.id); let captured = false;
    const provider = { lookup: vi.fn(() => Promise.resolve(captured ? ({ state: "CAPTURED" as const, ...providerReceipt("ACTUAL_LOST_ACK_CAPTURE") }) : { state: "APPROVED" as const })), capture: vi.fn(() => { captured = true; providerReceipt("ACTUAL_LOST_ACK_CAPTURE"); return Promise.reject(Error("Simulated lost provider acknowledgement")); }) };
    await expect(executeExternalPaymentCaptureReference(ref, { db, provider })).rejects.toThrow("Simulated lost provider acknowledgement");
    expect((await rows(f.org)).captures).toEqual([]);
    expect(await executeExternalPaymentCaptureReference(ref, { db, provider })).toMatchObject({ state: "CAPTURED" });
    expect(provider.capture).toHaveBeenCalledTimes(1); expect((await rows(f.org)).captures).toHaveLength(1);
  });
  it("reconciles an uncertain actual capture with GET after the original finance grant was revoked", async () => {
    const f = await fixture(), request = await requestExternalPaymentCapture(f.ctx, f.input, { db }), ref = await reference(f, request.id), before = await moneyFacts(f.org); let captured = false;
    const provider = { lookup: vi.fn(() => Promise.resolve(captured ? ({ state: "CAPTURED" as const, ...providerReceipt("RECONCILED_AFTER_REVOKE_" + request.id) }) : { state: "APPROVED" as const })),
      capture: vi.fn(async () => { captured = true; providerReceipt("RECONCILED_AFTER_REVOKE_" + request.id); await withTenant(db, f.org, tx => tx.roleAssignment.update({ where: { id: f.grant.id }, data: { archivedAt: new Date() } })); throw Error("Capture succeeded but its acknowledgement was lost"); }) };
    await expect(executeExternalPaymentCaptureReference(ref, { db, provider })).rejects.toThrow("Capture succeeded but its acknowledgement was lost");
    expect(await executeExternalPaymentCaptureReference(ref, { db, provider })).toMatchObject({ state: "CAPTURED" });
    expect(provider.capture).toHaveBeenCalledTimes(1); expect(await moneyFacts(f.org)).toEqual(before);
  });
  it("permits only read-only reconciliation after an uncertain attempt and refuses a new POST under revoked grants", async () => {
    const f = await fixture(), request = await requestExternalPaymentCapture(f.ctx, f.input, { db }), ref = await reference(f, request.id), provider = {
      lookup: vi.fn<() => Promise<{ state: "APPROVED" }>>().mockRejectedValueOnce(Error("Read acknowledgement unavailable")).mockResolvedValue({ state: "APPROVED" }),
      capture: vi.fn(() => Promise.resolve(providerReceipt("NEVER_POST_AFTER_REVOKE"))) };
    await expect(executeExternalPaymentCaptureReference(ref, { db, provider })).rejects.toThrow("Read acknowledgement unavailable");
    await withTenant(db, f.org, tx => tx.roleAssignment.update({ where: { id: f.grant.id }, data: { archivedAt: new Date() } }));
    await expect(executeExternalPaymentCaptureReference(ref, { db, provider })).rejects.toThrow(GuestDepositAuthorizationError);
    expect(provider.lookup).toHaveBeenCalledTimes(2); expect(provider.capture).not.toHaveBeenCalled(); expect((await rows(f.org)).captures).toEqual([]);
  });
  it("rolls the durable attempt back before provider I/O when its audit fails", async () => {
    const f = await fixture(), request = await requestExternalPaymentCapture(f.ctx, f.input, { db }), ref = await reference(f, request.id), write = auditWriter.writeAuditEvent,
      provider = { lookup: vi.fn(() => Promise.resolve({ state: "APPROVED" as const })), capture: vi.fn(() => Promise.resolve(providerReceipt("NEVER_POST_WITHOUT_ATTEMPT_AUDIT"))) };
    vi.spyOn(auditWriter, "writeAuditEvent").mockImplementation((tx, event) => { if (event.action === "finance.external_payment.capture_started") throw Error("Attempt audit unavailable"); return write(tx, event); });
    await expect(executeExternalPaymentCaptureReference(ref, { db, provider })).rejects.toThrow("Attempt audit unavailable");
    expect(provider.lookup).not.toHaveBeenCalled(); expect(provider.capture).not.toHaveBeenCalled();
    expect(await withTenant(db, f.org, tx => tx.externalPaymentAttempt.count({ where: { organizationId: f.org, intentId: request.id } }))).toBe(0);
  });
  it("requires current authority before any provider request", async () => {
    const f = await fixture(), request = await requestExternalPaymentCapture(f.ctx, f.input, { db }), ref = await reference(f, request.id), provider = { lookup: vi.fn(() => Promise.resolve({ state: "APPROVED" as const })), capture: vi.fn(() => Promise.resolve(providerReceipt("NEVER_CAPTURE"))) };
    await withTenant(db, f.org, tx => tx.roleAssignment.update({ where: { id: f.grant.id }, data: { archivedAt: new Date() } }));
    await expect(executeExternalPaymentCaptureReference(ref, { db, provider })).rejects.toThrow(GuestDepositAuthorizationError);
    expect(provider.lookup).not.toHaveBeenCalled(); expect(provider.capture).not.toHaveBeenCalled(); expect((await rows(f.org)).captures).toEqual([]);
  });
  it("retains an actual capture after an in-flight grant revocation without admitting or rewriting money", async () => {
    const f = await fixture(), request = await requestExternalPaymentCapture(f.ctx, f.input, { db }), ref = await reference(f, request.id), before = await moneyFacts(f.org);
    const provider = { lookup: vi.fn(() => Promise.resolve({ state: "APPROVED" as const })), capture: vi.fn(async () => { await withTenant(db, f.org, tx => tx.roleAssignment.update({ where: { id: f.grant.id }, data: { archivedAt: new Date() } })); return providerReceipt("ACTUAL_CAPTURE_BEFORE_REVOCATION_" + randomUUID()); }) };
    expect(await executeExternalPaymentCaptureReference(ref, { db, provider })).toMatchObject({ state: "CAPTURED" });
    expect((await rows(f.org)).captures).toHaveLength(1); expect(await moneyFacts(f.org)).toEqual(before);
  });
  it("refuses a second tenant's claim on the same provider order without disclosing its owner", async () => {
    const f = await fixture(), other = await fixture("0.07", f.input.orderId);
    await requestExternalPaymentCapture(f.ctx, f.input, { db });
    await expect(requestExternalPaymentCapture(other.ctx, other.input, { db })).rejects.toThrow(ExternalPaymentIntentError);
    expect((await rows(other.org)).intents).toEqual([]);
  });
  it("rejects foreign event references before any provider I/O", async () => {
    const f = await fixture(), other = await fixture(), request = await requestExternalPaymentCapture(f.ctx, f.input, { db }), ref = await reference(f, request.id), provider = { lookup: vi.fn(() => Promise.resolve({ state: "APPROVED" as const })), capture: vi.fn(() => Promise.resolve(providerReceipt("NEVER_CAPTURE"))) };
    await expect(executeExternalPaymentCaptureReference({ ...ref, organizationId: other.org }, { db, provider })).rejects.toThrow(ExternalPaymentIntentError);
    expect(provider.lookup).not.toHaveBeenCalled();
    expect(await withTenant(db, other.org, tx => tx.externalPaymentIntent.findMany({ where: { organizationId: f.org } }))).toEqual([]);
  });
  it("requires confirmed native capture evidence before the original receipt producer can admit its reserved nonce", async () => {
    const f = await fixture(), before = await moneyFacts(f.org); await requestExternalPaymentCapture(f.ctx, f.input, { db });
    await expect(postGuestDepositReceipt(f.ctx, f.input.receipt, { db })).rejects.toThrow("verified original external capture required before financial admission");
    expect(await moneyFacts(f.org)).toEqual(before);
  });
  it("rolls the intent back when its audit fails", async () => {
    const f = await fixture(), write = auditWriter.writeAuditEvent;
    vi.spyOn(auditWriter, "writeAuditEvent").mockImplementation((tx, event) => { if (event.action === "finance.external_payment.requested") throw Error("Intent audit unavailable"); return write(tx, event); });
    await expect(requestExternalPaymentCapture(f.ctx, f.input, { db })).rejects.toThrow("Intent audit unavailable");
    expect((await rows(f.org)).intents).toEqual([]);
  });
  it("reconciles the original capture after a local evidence-audit rollback", async () => {
    const f = await fixture(), request = await requestExternalPaymentCapture(f.ctx, f.input, { db }), ref = await reference(f, request.id), write = auditWriter.writeAuditEvent;
    const provider = { lookup: vi.fn(() => Promise.resolve(({ state: "CAPTURED" as const, ...providerReceipt("ACTUAL_CAPTURE_AUDIT_RECOVERY_" + randomUUID()) }))), capture: vi.fn(() => Promise.resolve(providerReceipt("NEVER_POST"))) };
    provider.lookup.mockResolvedValue(({ state: "CAPTURED" as const, ...providerReceipt("ACTUAL_CAPTURE_AUDIT_RECOVERY_" + randomUUID()) }));
    const spy = vi.spyOn(auditWriter, "writeAuditEvent").mockImplementation((tx, event) => { if (event.action === "finance.external_payment.captured") throw Error("Capture audit unavailable"); return write(tx, event); });
    await expect(executeExternalPaymentCaptureReference(ref, { db, provider })).rejects.toThrow("Capture audit unavailable"); expect((await rows(f.org)).captures).toEqual([]);
    spy.mockRestore(); expect(await executeExternalPaymentCaptureReference(ref, { db, provider })).toMatchObject({ state: "CAPTURED" }); expect(provider.capture).not.toHaveBeenCalled();
  });
  it("preserves every intent and capture witness against update and deletion", async () => {
    const f = await fixture(), request = await requestExternalPaymentCapture(f.ctx, f.input, { db }), ref = await reference(f, request.id), provider = { lookup: vi.fn(() => Promise.resolve(({ state: "CAPTURED" as const, ...providerReceipt("ACTUAL_APPEND_ONLY_CAPTURE_" + randomUUID()) }))), capture: vi.fn(() => Promise.resolve(providerReceipt("NEVER_POST"))) };
    await executeExternalPaymentCaptureReference(ref, { db, provider }); const before = await rows(f.org), capture = before.captures[0];
    await expect(withTenant(db, f.org, tx => tx.externalPaymentIntent.update({ where: { id: request.id }, data: { amount: "0.08" } }))).rejects.toThrow();
    await expect(withTenant(db, f.org, tx => tx.externalPaymentIntent.delete({ where: { id: request.id } }))).rejects.toThrow();
    await expect(withTenant(db, f.org, tx => tx.externalPaymentCapture.update({ where: { id: capture.id }, data: providerReceipt("SUBSTITUTED_CAPTURE") }))).rejects.toThrow();
    await expect(withTenant(db, f.org, tx => tx.externalPaymentCapture.delete({ where: { id: capture.id } }))).rejects.toThrow(); expect(await rows(f.org)).toEqual(before);
    const attempt = await withTenant(db, f.org, tx => tx.externalPaymentAttempt.findFirstOrThrow({ where: { organizationId: f.org, intentId: request.id } }));
    await expect(withTenant(db, f.org, tx => tx.externalPaymentAttempt.update({ where: { id: attempt.id }, data: { startedAt: new Date() } }))).rejects.toThrow();
    await expect(withTenant(db, f.org, tx => tx.externalPaymentAttempt.delete({ where: { id: attempt.id } }))).rejects.toThrow();
  });
  it("refuses a native capture of a different exact amount", async () => {
    const f = await fixture(), request = await requestExternalPaymentCapture(f.ctx, f.input, { db });
    const ref = await reference(f, request.id), provider = { lookup: vi.fn<() => Promise<{ state: "APPROVED" }>>().mockRejectedValue(Error("Provider read acknowledgement unavailable")), capture: vi.fn(() => Promise.resolve(providerReceipt("NEVER_POST"))) };
    await expect(executeExternalPaymentCaptureReference(ref, { db, provider })).rejects.toThrow("Provider read acknowledgement unavailable");
    await expect(withTenant(db, f.org, tx => new ExternalPaymentRepository(tx, f.org).capture(request.id, { schemaVersion: 1, provider: "paypal", orderId: f.input.orderId, paymentId: "FORGED_CAPTURE", amount: { amount: "0.08", currency: "MAD" } }, new Date().toISOString(), null))).rejects.toThrow("original exact provider capture required");
    expect((await rows(f.org)).captures).toEqual([]);
  });
  it("admits the exact confirmed capture through one original journal and provenance, then recovers after method disablement", async () => {
    const f = await fixture(), requested = await requestExternalPaymentCapture(f.ctx, f.input, { db }), ref = await reference(f, requested.id),
      provider = { lookup: vi.fn(() => Promise.resolve(({ state: "CAPTURED" as const, ...providerReceipt("ACTUAL_NATIVE_ADMISSION_" + randomUUID()) }))), capture: vi.fn(() => Promise.resolve(providerReceipt("NEVER_POST"))) };
    await executeExternalPaymentCaptureReference(ref, { db, provider }); const review = await reviewCapturedPayPalAdmission(f.ctx, { id: requested.id }, { db }),
      input = { intentId: requested.id, reviewFingerprint: review.reviewFingerprint, paymentMethodFingerprint: review.paymentMethodFingerprint, reason: "Admit the confirmed original external funds under their reviewed native receipt" }, before = await moneyFacts(f.org),
      admitted = await admitCapturedPayPalPayment(f.ctx, input, { db });
    expect(admitted).toMatchObject({ depositId: f.input.receipt.idempotencyKey, operation: "RECEIPT", idempotent: false });
    const source = await withTenant(db, f.org, async tx => ({ intent: await tx.externalPaymentIntent.findFirstOrThrow({ where: { id: requested.id, organizationId: f.org } }),
      receipt: await tx.guestPaymentReceipt.findFirstOrThrow({ where: { organizationId: f.org, transactionId: admitted.id } }), postings: await tx.posting.findMany({ where: { organizationId: f.org, transactionId: admitted.id } }) }));
    expect(source.postings).toHaveLength(2); expect(source.postings.map(posting => posting.amount.toFixed(2))).toEqual(["0.07", "0.07"]);
    expect(source.receipt).toMatchObject({ accountId: f.banks.receipt.id, collectorUserAccountId: f.account.id, collectorPersonId: f.person.id });
    expect(source.receipt.financialSnapshotId).toBe((source.intent.sourceSnapshot as { financialSnapshotId: string }).financialSnapshotId);
    const old = new Set(before.map(row => row.kind + row.id)), saved = await moneyFacts(f.org); expect(saved.filter(row => old.has(row.kind + row.id))).toEqual(before);
    await withTenant(db, f.org, tx => new ConfigRuleRepository(tx, f.org).createVersion({ key: "finance.payment_methods", scopeType: "organization", effectiveFrom: new Date("2020-01-01"), createdBy: f.account.id,
      value: { methods: [{ key: "confirmed-paypal", labels, adapter: "paypal", enabled: false, currencies: ["MAD"] }] }, reason: "Disable new optional external payments while preserving the original accepted source" }));
    expect(await admitCapturedPayPalPayment(f.ctx, input, { db })).toEqual({ ...admitted, idempotent: true }); expect(await moneyFacts(f.org)).toEqual(saved); expect(provider.capture).not.toHaveBeenCalled();
    expect((await getExternalPaymentIntent(f.ctx, { id: requested.id }, { db })).amount).toEqual({ amount: "0.07", currency: "MAD" });
  });
  it("rolls financial admission back after final independent pay revocation while preserving the actual external capture", async () => {
    const f = await fixture(), requested = await requestExternalPaymentCapture(f.ctx, f.input, { db }), ref = await reference(f, requested.id),
      provider = { lookup: vi.fn(() => Promise.resolve(({ state: "CAPTURED" as const, ...providerReceipt("ACTUAL_HELD_NATIVE_CAPTURE_" + randomUUID()) }))), capture: vi.fn(() => Promise.resolve(providerReceipt("NEVER_POST"))) };
    await executeExternalPaymentCaptureReference(ref, { db, provider }); const review = await reviewCapturedPayPalAdmission(f.ctx, { id: requested.id }, { db }), before = await moneyFacts(f.org), write = auditWriter.writeAuditEvent;
    vi.spyOn(auditWriter, "writeAuditEvent").mockImplementation(async (tx, event) => { const saved = await write(tx, event); if (event.action === "finance.payment_method.accepted") {
      const revoked = await withTenant(db, f.org, inner => inner.rolePermission.deleteMany({ where: { organizationId: f.org, roleId: f.role.id, permission: { key: "financial_transaction:pay" } } })); expect(revoked.count).toBe(1);
    } return saved; });
    await expect(admitCapturedPayPalPayment(f.ctx, { intentId: requested.id, reviewFingerprint: review.reviewFingerprint, paymentMethodFingerprint: review.paymentMethodFingerprint, reason: "Require final actual independent financial pay authority" }, { db })).rejects.toThrow(PaymentMethodAccessError);
    expect(await moneyFacts(f.org)).toEqual(before); expect((await rows(f.org)).captures).toHaveLength(1);
  });
  it("withholds retained capture history when current source authority is revoked", async () => {
    const f = await fixture(), requested = await requestExternalPaymentCapture(f.ctx, f.input, { db });
    await withTenant(db, f.org, tx => tx.roleAssignment.update({ where: { id: f.grant.id }, data: { archivedAt: new Date() } }));
    await expect(getExternalPaymentIntent(f.ctx, { id: requested.id }, { db })).rejects.toThrow(PaymentMethodAccessError);
  });
  it("refuses an optional provider with no explicit merchant-account mapping before queuing any capture", async () => {
    const f = await fixture();
    await withTenant(db, f.org, async tx => {
      await new ConfigRuleRepository(tx, f.org).createVersion({ key: "finance.payment_methods", scopeType: "organization", effectiveFrom: new Date("2020-01-01"), createdBy: f.account.id,
        value: { methods: [{ key: "confirmed-paypal", labels, adapter: "paypal", enabled: true, currencies: ["MAD"] }] }, reason: "Unconfigured provider location must not be inferred from the selected bank" });
      f.input.receipt.paymentMethodFingerprint = (await new PaymentMethodRepository(tx, f.org).catalog({ at: await new FinanceRepository(tx, f.org).clock(), currency: "MAD", scopes: [{ scopeType: "organization", scopeId: null }] })).identity;
    });
    await expect(requestExternalPaymentCapture(f.ctx, f.input, { db })).rejects.toThrow(PaymentMethodConfigurationError); expect((await rows(f.org)).intents).toEqual([]);
  });
  it("refuses a caller-selected different bank despite otherwise valid receipt and source permissions", async () => {
    const f = await fixture(), before = await moneyFacts(f.org); f.input.receipt.accountId = f.receiptInput.accountId;
    f.input.receipt.reviewFingerprint = await withTenant(db, f.org, async tx => (await inspectGuestDepositReceiptInTransaction(f.ctx, { ...f.receiptInput, method: "confirmed-paypal", externalReference: f.input.orderId }, tx)).fingerprint);
    await expect(requestExternalPaymentCapture(f.ctx, f.input, { db })).rejects.toThrow(PaymentMethodConfigurationError);
    expect((await rows(f.org)).intents).toEqual([]); expect(await moneyFacts(f.org)).toEqual(before);
  });
  it("admits already-captured money under its retained original method after new captures are disabled and remapped", async () => {
    const f = await fixture(), requested = await requestExternalPaymentCapture(f.ctx, f.input, { db }), ref = await reference(f, requested.id), provider = {
      lookup: vi.fn(() => Promise.resolve({ state: "CAPTURED" as const, ...providerReceipt("ORIGINAL_DISABLED_METHOD_CAPTURE_" + randomUUID()) })), capture: vi.fn(() => Promise.resolve(providerReceipt("NEVER_CAPTURE_AGAIN"))) };
    await executeExternalPaymentCaptureReference(ref, { db, provider });
    await withTenant(db, f.org, tx => new ConfigRuleRepository(tx, f.org).createVersion({ key: "finance.payment_methods", scopeType: "organization", effectiveFrom: new Date("2020-01-01"), createdBy: f.account.id,
      value: { methods: [{ key: "confirmed-paypal", labels, adapter: "paypal", enabled: false, currencies: ["MAD"], provider_account_code: f.banks.refund.code }] }, reason: "Disable future captures without moving original provider-held money into another bank" }));
    const review = await reviewCapturedPayPalAdmission(f.ctx, { id: requested.id }, { db }); expect(review.method.provider_account_code).toBe(f.banks.receipt.code);
    const admitted = await admitCapturedPayPalPayment(f.ctx, { intentId: requested.id, reviewFingerprint: review.reviewFingerprint, paymentMethodFingerprint: review.paymentMethodFingerprint, reason: "Record the actual original capture in its retained merchant location" }, { db });
    const proof = await withTenant(db, f.org, async tx => ({ source: await tx.externalPaymentIntent.findFirstOrThrow({ where: { id: requested.id, organizationId: f.org } }),
      acceptance: await tx.auditLog.findFirstOrThrow({ where: { organizationId: f.org, resourceId: admitted.id, action: "finance.payment_method.accepted" } }),
      receipt: await tx.guestPaymentReceipt.findFirstOrThrow({ where: { organizationId: f.org, transactionId: admitted.id } }) }));
    expect(proof.receipt.accountId).toBe(f.banks.receipt.id); expect(proof.acceptance.after).toMatchObject({ policyId: proof.source.policyId, policyVersion: proof.source.policyVersion }); expect(provider.capture).not.toHaveBeenCalled();
    const forged = { ...(proof.acceptance.after as Record<string, unknown>), policyId: randomUUID() };
    await expect(withTenant(db, f.org, tx => auditWriter.writeAuditEvent(tx, { organizationId: f.org, actorId: f.account.id, resourceType: "financial_transaction", resourceId: admitted.id,
      action: "finance.payment_method.accepted", after: forged, reason: "Prove native refusal of a forged captured method attribution", requestId: randomUUID(), occurredAt: new Date() }))).rejects.toThrow("actual original captured method audit required");
  });
  it("posts the provider's original capture date across a month boundary instead of the later reconciliation clock", async () => {
    const f = await fixture(), now = new Date(f.receiptInput.receivedAt), capturedAt = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 0, 23, 59, 59)).toISOString(), paymentId = "ACTUAL_PRIOR_MONTH_CAPTURE_" + randomUUID();
    captureTimes.set(paymentId, capturedAt); const requested = await requestExternalPaymentCapture(f.ctx, f.input, { db }), ref = await reference(f, requested.id), provider = {
      lookup: vi.fn(() => Promise.resolve({ state: "CAPTURED" as const, ...providerReceipt(paymentId) })), capture: vi.fn(() => Promise.resolve(providerReceipt("NEVER_CAPTURE_AGAIN"))) };
    const captured = await executeExternalPaymentCaptureReference(ref, { db, provider }); expect(captured.capturedAt).toBe(capturedAt); expect(captured.observedAt?.slice(0, 7)).not.toBe(capturedAt.slice(0, 7));
    const review = await reviewCapturedPayPalAdmission(f.ctx, { id: requested.id }, { db }); expect(review.receivedAt).toBe(capturedAt);
    const admitted = await admitCapturedPayPalPayment(f.ctx, { intentId: requested.id, reviewFingerprint: review.reviewFingerprint, paymentMethodFingerprint: review.paymentMethodFingerprint, reason: "Retain the actual original economic date without synthetic reconciliation-time dating" }, { db });
    const original = await withTenant(db, f.org, tx => tx.financialTransaction.findFirstOrThrow({ where: { organizationId: f.org, id: admitted.id } })); expect(original.occurredAt.toISOString()).toBe(capturedAt); expect(provider.capture).not.toHaveBeenCalled();
  });
  it("retains nonzero deductions and actual net while withholding an incomplete gross-only financial admission", async () => {
    const f = await fixture(), request = await requestExternalPaymentCapture(f.ctx, f.input, { db }), ref = await reference(f, request.id), before = await moneyFacts(f.org), evidence = providerReceipt("ACTUAL_NET_CAPTURE_" + randomUUID());
    evidence.settlement.fee.amount = "0.02"; evidence.settlement.net.amount = "0.05";
    const provider = { lookup: vi.fn(() => Promise.resolve({ state: "CAPTURED" as const, ...evidence })), capture: vi.fn(() => Promise.resolve(providerReceipt("NEVER_CAPTURE_AGAIN"))) };
    const retained = await executeExternalPaymentCaptureReference(ref, { db, provider }); expect(retained.settlement).toMatchObject({ gross: { amount: "0.07" }, fee: { amount: "0.02" }, net: { amount: "0.05" } });
    const review = await reviewCapturedPayPalAdmission(f.ctx, { id: request.id }, { db });
    await expect(admitCapturedPayPalPayment(f.ctx, { intentId: request.id, reviewFingerprint: review.reviewFingerprint, paymentMethodFingerprint: review.paymentMethodFingerprint, reason: "Do not claim gross funds are physically held before the actual deduction is posted" }, { db })).rejects.toThrow(ExternalPaymentIntentError);
    expect(await moneyFacts(f.org)).toEqual(before); expect((await rows(f.org)).captures).toHaveLength(1); expect(provider.capture).not.toHaveBeenCalled();
  });
  it("does not fabricate net or a zero fee when the original provider settlement is unavailable", async () => {
    const f = await fixture(), request = await requestExternalPaymentCapture(f.ctx, f.input, { db }), ref = await reference(f, request.id), before = await moneyFacts(f.org),
      provider = { lookup: vi.fn(() => Promise.resolve({ state: "CAPTURED" as const, ...providerReceipt("ACTUAL_UNKNOWN_NET_" + randomUUID()), settlement: null })), capture: vi.fn(() => Promise.resolve(providerReceipt("NEVER_CAPTURE_AGAIN"))) };
    const retained = await executeExternalPaymentCaptureReference(ref, { db, provider }); expect(retained.state).toBe("CAPTURED"); expect(retained.settlement).toBeNull();
    const review = await reviewCapturedPayPalAdmission(f.ctx, { id: request.id }, { db });
    await expect(admitCapturedPayPalPayment(f.ctx, { intentId: request.id, reviewFingerprint: review.reviewFingerprint, paymentMethodFingerprint: review.paymentMethodFingerprint, reason: "Keep the actual capture without inventing its unavailable merchant settlement" }, { db })).rejects.toThrow(ExternalPaymentIntentError);
    expect(await moneyFacts(f.org)).toEqual(before); expect((await rows(f.org)).captures).toHaveLength(1);
  });
});
