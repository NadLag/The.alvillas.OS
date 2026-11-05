import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { PrismaClient } from "@prisma/client";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { withTenant } from "@/platform/db/tenant";
import { ConfigRuleRepository } from "@/platform/config/config-rule-repository";
import { Money } from "@/platform/money/money";
import * as audits from "@/platform/audit/audit-writer";
import { FinanceRepository } from "@/modules/finance/infrastructure/finance-repository";
import { PaymentMethodRepository } from "@/modules/finance/infrastructure/payment-method-repository";
import { ExternalPaymentRefundRepository } from "@/modules/finance/infrastructure/external-payment-refund-repository";
import { guestPaymentMethodScopes } from "@/modules/finance/application/guest-deposit-payment-method";
import { inspectGuestDepositReceiptInTransaction, reviewGuestDepositRefund, postGuestDepositRefund } from "@/modules/finance/application/guest-deposit-service";
import { requestExternalPaymentCapture, executeExternalPaymentCaptureReference, externalPaymentCaptureRequested } from "@/modules/finance/application/external-payment-service";
import { reviewCapturedPayPalAdmission } from "@/modules/finance/application/external-payment-workspace-service";
import { admitCapturedPayPalPayment } from "@/modules/finance/application/native-paypal-admission";
import { requestExternalPaymentRefund, executeExternalPaymentRefundReference, externalPaymentRefundRequested } from "@/modules/finance/application/external-payment-refund-service";
import { actualGuestDepositFixture } from "./support/guest-deposit-fixture";
import { provisionIntegrationRole } from "./support/database-role";

let admin: PrismaClient, db: PrismaClient, control: PrismaClient;
beforeAll(async () => {
  const url = process.env.TEST_DATABASE_URL, target = url ? new URL(url) : null;
  if (!target || !["localhost", "127.0.0.1"].includes(target.hostname) || !(target.pathname.startsWith("/alvillas_automation_") || process.env.GITHUB_ACTIONS === "true" && target.pathname === "/alvillas_os")) throw Error("Owned external-refund acceptance database required");
  control = new PrismaClient({ datasourceUrl: url }); const database = "alvillas_automation_refund176_" + randomUUID().replaceAll("-", "").slice(0, 20);
  await control.$executeRawUnsafe('CREATE DATABASE "' + database + '"'); const shadow = new URL(url!); shadow.pathname = "/" + database;
  execFileSync(process.execPath, ["node_modules/prisma/build/index.js", "migrate", "deploy", "--schema", resolve("prisma/schema.prisma")], { env: { ...process.env, DATABASE_URL: shadow.toString() }, stdio: "pipe" });
  admin = new PrismaClient({ datasourceUrl: shadow.toString() }); await provisionIntegrationRole(admin, "alvillas_ops_tests"); const restricted = new URL(shadow); restricted.username = restricted.password = "alvillas_ops_tests"; db = new PrismaClient({ datasourceUrl: restricted.toString() });
  expect(await db.$queryRaw`SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user`).toEqual([{ rolsuper: false, rolbypassrls: false }]);
  await admin.currency.upsert({ where: { code: "MAD" }, update: {}, create: { code: "MAD", name: "MAD", minorUnit: 2 } });
}, 120000);
afterEach(() => vi.restoreAllMocks()); afterAll(async () => { await db?.$disconnect(); await admin?.$disconnect(); await control?.$disconnect(); });
const labels = { en: "Original PayPal", fr: "PayPal initial", ar: "باي بال الأصلي" };
async function fixture() {
  const f = await actualGuestDepositFixture(db, admin, "MAD", 2, "0.07"), merchant = await withTenant(db, f.org, tx => new FinanceRepository(tx, f.org).ensureLedgerAccount({ code: "PAYPAL_MERCHANT_BALANCE", name: "Actual merchant funds", accountType: "ASSET_LOCATION", normalSide: "DEBIT" }));
  const orderId = "ORDER_" + randomUUID(), input = await withTenant(db, f.org, async tx => {
    const rules = new ConfigRuleRepository(tx, f.org);
    await rules.createVersion({ key: "finance.guest_deposits", scopeType: "organization", effectiveFrom: new Date("2020-01-01"), createdBy: f.account.id,
      value: { ...f.policy, receipt_account_codes: [...f.policy.receipt_account_codes, merchant.code], refund_account_codes: [...f.policy.refund_account_codes, merchant.code], payment_methods: [...f.policy.payment_methods, { key: "confirmed-paypal", labels }] }, reason: "Explicit original capture and refund configuration" });
    await rules.createVersion({ key: "finance.payment_methods", scopeType: "organization", effectiveFrom: new Date("2020-01-01"), createdBy: f.account.id,
      value: { methods: [{ key: "confirmed-paypal", labels, adapter: "paypal", enabled: true, currencies: ["MAD"], provider_account_code: merchant.code }] }, reason: "Explicit original provider merchant mapping" });
    const receipt = { ...f.receiptInput, accountId: merchant.id, method: "confirmed-paypal", externalReference: orderId }, prepared = await inspectGuestDepositReceiptInTransaction(f.ctx, receipt, tx),
      now = await new FinanceRepository(tx, f.org).clock(), catalog = await new PaymentMethodRepository(tx, f.org).catalog({ at: now, currency: "MAD", scopes: await guestPaymentMethodScopes(tx, f.org, f.reservationId, now) });
    return { provider: "paypal" as const, orderId, receipt: { ...receipt, idempotencyKey: randomUUID(), reason: "Retain an original provider guest payment before refund", reviewFingerprint: prepared.fingerprint, paymentMethodFingerprint: catalog.identity } };
  });
  const requested = await requestExternalPaymentCapture(f.ctx, input, { db }), captureEvent = await withTenant(db, f.org, tx => tx.outboxEvent.findFirstOrThrow({ where: { organizationId: f.org, type: externalPaymentCaptureRequested, payload: { path: ["intentId"], equals: requested.id } } })),
    capturedAt = new Date().toISOString(), capture = { paymentId: "CAPTURE_" + randomUUID(), capturedAt, settlement: { schemaVersion: 1 as const, basis: "ORIGINAL_PROVIDER_RECEIVABLE_BREAKDOWN" as const, gross: { amount: "0.07", currency: "MAD" }, fee: { amount: "0.00", currency: "MAD" }, net: { amount: "0.07", currency: "MAD" } } };
  const observed = await executeExternalPaymentCaptureReference({ organizationId: f.org, outboxEventId: captureEvent.id }, { db, provider: { lookup: () => Promise.resolve({ state: "CAPTURED" as const, ...capture }), capture: () => Promise.resolve(capture) } });
  const admission = await reviewCapturedPayPalAdmission(f.ctx, { id: requested.id }, { db }); await admitCapturedPayPalPayment(f.ctx, { intentId: requested.id, reviewFingerprint: admission.reviewFingerprint, paymentMethodFingerprint: admission.paymentMethodFingerprint, reason: "Admit verified original merchant funds before refund" }, { db });
  return { ...f, merchant, input, capture, captureId: observed.captureId! };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function draft(f: Fixture, amount = "0.03") {
  const refund = { depositId: f.input.receipt.idempotencyKey, accountId: f.merchant.id, amount, currency: "MAD", method: "confirmed-paypal", externalReference: null, purpose: "Actual partial provider refund" }, review = await reviewGuestDepositRefund(f.ctx, refund, { db });
  return { captureId: f.captureId, refund: { ...refund, reviewFingerprint: review.reviewFingerprint, idempotencyKey: randomUUID(), reason: "Refund only the reviewed original guest funds" } };
}
async function reference(f: Fixture, intentId: string) { const event = await withTenant(db, f.org, tx => tx.outboxEvent.findFirstOrThrow({ where: { organizationId: f.org, type: externalPaymentRefundRequested, payload: { path: ["intentId"], equals: intentId } } })); return { organizationId: f.org, outboxEventId: event.id }; }
const facts = (org: string) => withTenant(db, org, tx => tx.$queryRaw<Array<{ kind: string; id: string; xmin: string; body: string }>>`SELECT 'journal' AS kind,id::text,xmin::text,to_jsonb(t)::text AS body FROM financial_transaction t WHERE organization_id=${org}::uuid UNION ALL SELECT 'posting',id::text,xmin::text,to_jsonb(p)::text FROM posting p WHERE organization_id=${org}::uuid ORDER BY kind,id`);
function gateway(f: Fixture, input: Awaited<ReturnType<typeof draft>>, state: "PENDING" | "COMPLETED" = "COMPLETED") {
  const at = new Date().toISOString(), evidence = { refundId: "REFUND_" + randomUUID(), captureId: f.capture.paymentId, requestId: input.refund.idempotencyKey, amount: { amount: input.refund.amount, currency: "MAD" }, state, createdAt: at, updatedAt: at, refundedAt: state === "COMPLETED" ? at : null };
  return { evidence, refund: vi.fn(() => Promise.resolve({ ...evidence, settlement: null })), lookupRefund: vi.fn(() => Promise.resolve({ ...evidence, settlement: null })) };
}
describe("original provider refund reservations on PostgreSQL", () => {
  it("reserves the exact original funds and queues a recoverable source without changing financial history", async () => {
    const f = await fixture(), input = await draft(f), before = await facts(f.org), request = await requestExternalPaymentRefund(f.ctx, input, { db });
    expect(request).toMatchObject({ state: "QUEUED", amount: { amount: "0.03", currency: "MAD" }, idempotent: false });
    expect(await requestExternalPaymentRefund(f.ctx, input, { db })).toMatchObject({ id: request.id, idempotent: true });
    expect(await withTenant(db, f.org, tx => new ExternalPaymentRefundRepository(tx, f.org).reserved(input.refund.depositId))).toBe("0.03"); expect(await facts(f.org)).toEqual(before);
    expect(await reference(f, request.id)).toHaveProperty("outboxEventId");
  });
  it("serializes competing reservations against the same remaining source", async () => {
    const f = await fixture(), a = await draft(f, "0.05"), b = await draft(f, "0.05"), before = await facts(f.org), outcomes = await Promise.allSettled([requestExternalPaymentRefund(f.ctx, a, { db }), requestExternalPaymentRefund(f.ctx, b, { db })]);
    expect(outcomes.filter(result => result.status === "fulfilled")).toHaveLength(1); expect(outcomes.filter(result => result.status === "rejected")).toHaveLength(1);
    expect(await withTenant(db, f.org, tx => new ExternalPaymentRefundRepository(tx, f.org).reserved(a.refund.depositId))).toBe("0.05"); expect(await facts(f.org)).toEqual(before);
  });
  it("retains a completed independent provider refund after grants end without admitting another journal", async () => {
    const f = await fixture(), input = await draft(f), request = await requestExternalPaymentRefund(f.ctx, input, { db }), ref = await reference(f, request.id), before = await facts(f.org), provider = gateway(f, input);
    provider.refund.mockImplementationOnce(async () => { await admin.rolePermission.deleteMany({ where: { organizationId: f.org, roleId: f.role.id } }); return { ...provider.evidence, settlement: null }; });
    expect(await executeExternalPaymentRefundReference(ref, { db, provider })).toMatchObject({ state: "COMPLETED", refundId: provider.evidence.refundId }); expect(provider.refund).toHaveBeenCalledTimes(1); expect(await facts(f.org)).toEqual(before);
    expect(await executeExternalPaymentRefundReference(ref, { db, provider })).toMatchObject({ state: "COMPLETED", idempotent: true }); expect(provider.refund).toHaveBeenCalledTimes(1); expect(provider.lookupRefund).toHaveBeenCalledTimes(1);
  });
  it("never sends a second monetary POST after an unknown first response", async () => {
    const f = await fixture(), input = await draft(f), request = await requestExternalPaymentRefund(f.ctx, input, { db }), ref = await reference(f, request.id), provider = gateway(f, input);
    provider.refund.mockRejectedValueOnce(new Error("fixture-lost-private-provider-response")); await expect(executeExternalPaymentRefundReference(ref, { db, provider })).rejects.toThrow("fixture-lost-private-provider-response");
    expect(await executeExternalPaymentRefundReference(ref, { db, provider })).toMatchObject({ state: "UNCONFIRMED" }); expect(provider.refund).toHaveBeenCalledTimes(1); expect(provider.lookupRefund).not.toHaveBeenCalled();
    expect(await withTenant(db, f.org, tx => new ExternalPaymentRefundRepository(tx, f.org).reserved(input.refund.depositId))).toBe("0.03");
  });
  it("does not represent pending provider evidence as completed funds", async () => {
    const f = await fixture(), input = await draft(f), request = await requestExternalPaymentRefund(f.ctx, input, { db }), provider = gateway(f, input, "PENDING"), before = await facts(f.org);
    expect(await executeExternalPaymentRefundReference(await reference(f, request.id), { db, provider })).toMatchObject({ state: "PENDING", refundedAt: null }); expect(await facts(f.org)).toEqual(before);
    expect(Money.of(await withTenant(db, f.org, tx => new ExternalPaymentRefundRepository(tx, f.org).reserved(input.refund.depositId)), "MAD").toJSON().amount).toBe("0.03");
  });
  it("retains exact provider gross, fee and merchant net separately from refund admission", async () => {
    const f = await fixture(), input = await draft(f), request = await requestExternalPaymentRefund(f.ctx, input, { db }), provider = gateway(f, input), before = await facts(f.org),
      settlement = { schemaVersion: 1 as const, basis: "ORIGINAL_PROVIDER_PAYABLE_BREAKDOWN" as const, gross: { amount: "0.03", currency: "MAD" }, fee: { amount: "0.02", currency: "MAD" }, net: { amount: "0.01", currency: "MAD" }, totalRefunded: { amount: "0.03", currency: "MAD" } };
    const result = await executeExternalPaymentRefundReference(await reference(f, request.id), { db, provider: { refund: () => Promise.resolve({ ...provider.evidence, settlement }), lookupRefund: () => Promise.resolve({ ...provider.evidence, settlement }) } });
    expect(result).toMatchObject({ state: "COMPLETED" });
    const rows = await withTenant(db, f.org, tx => tx.externalPaymentRefundSettlement.findMany({ where: { organizationId: f.org }, include: { evidence: true } }));
    expect(rows).toHaveLength(1); expect(rows[0].settlement).toEqual(settlement); expect(rows[0].evidence.evidence).toEqual(provider.evidence); expect(await facts(f.org)).toEqual(before);
    expect(await withTenant(db, f.org, tx => tx.auditLog.count({ where: { organizationId: f.org, action: "finance.external_payment.refund_settlement_retained", resourceId: request.id } }))).toBe(1);
  });
  it("adds missing settlement after read-only reconciliation without rewriting the original observation", async () => {
    const f = await fixture(), input = await draft(f), request = await requestExternalPaymentRefund(f.ctx, input, { db }), ref = await reference(f, request.id), provider = gateway(f, input);
    await executeExternalPaymentRefundReference(ref, { db, provider });
    const original = await withTenant(db, f.org, tx => tx.$queryRaw<Array<{ id: string; xmin: string; body: string }>>`SELECT id::text,xmin::text,to_jsonb(e)::text AS body FROM external_payment_refund_evidence e WHERE organization_id=${f.org}::uuid`),
      settlement = { schemaVersion: 1 as const, basis: "ORIGINAL_PROVIDER_PAYABLE_BREAKDOWN" as const, gross: { amount: "0.03", currency: "MAD" }, fee: { amount: "0.00", currency: "MAD" }, net: { amount: "0.03", currency: "MAD" }, totalRefunded: null };
    await executeExternalPaymentRefundReference(ref, { db, provider: { refund: provider.refund, lookupRefund: () => Promise.resolve({ ...provider.evidence, settlement }) } });
    expect(await withTenant(db, f.org, tx => tx.$queryRaw<Array<{ id: string; xmin: string; body: string }>>`SELECT id::text,xmin::text,to_jsonb(e)::text AS body FROM external_payment_refund_evidence e WHERE organization_id=${f.org}::uuid`)).toEqual(original);
    expect(await withTenant(db, f.org, tx => tx.externalPaymentRefundSettlement.count({ where: { organizationId: f.org } }))).toBe(1); expect(provider.refund).toHaveBeenCalledTimes(1);
  });
  it("rolls back unaudited settlement without releasing its original uncertain money reservation", async () => {
    const f = await fixture(), input = await draft(f), request = await requestExternalPaymentRefund(f.ctx, input, { db }), provider = gateway(f, input), before = await facts(f.org),
      settlement = { schemaVersion: 1 as const, basis: "ORIGINAL_PROVIDER_PAYABLE_BREAKDOWN" as const, gross: { amount: "0.03", currency: "MAD" }, fee: { amount: "0.00", currency: "MAD" }, net: { amount: "0.03", currency: "MAD" }, totalRefunded: null }, write = audits.writeAuditEvent;
    vi.spyOn(audits, "writeAuditEvent").mockImplementation(async (tx, event) => { if (event.action === "finance.external_payment.refund_settlement_retained") return undefined; return write(tx, event); });
    await expect(executeExternalPaymentRefundReference(await reference(f, request.id), { db, provider: { refund: () => Promise.resolve({ ...provider.evidence, settlement }), lookupRefund: () => Promise.resolve({ ...provider.evidence, settlement }) } })).rejects.toThrow("exact original provider refund settlement and attributed audit");
    expect(await withTenant(db, f.org, tx => tx.externalPaymentRefundSettlement.count({ where: { organizationId: f.org } }))).toBe(0);
    expect(await withTenant(db, f.org, tx => new ExternalPaymentRefundRepository(tx, f.org).reserved(input.refund.depositId))).toBe("0.03"); expect(await facts(f.org)).toEqual(before);
  });
  it("keeps populated refund settlement private to its source tenant", async () => {
    const f = await fixture(), other = await fixture(), input = await draft(f), request = await requestExternalPaymentRefund(f.ctx, input, { db }), provider = gateway(f, input),
      settlement = { schemaVersion: 1 as const, basis: "ORIGINAL_PROVIDER_PAYABLE_BREAKDOWN" as const, gross: { amount: "0.03", currency: "MAD" }, fee: { amount: "0.00", currency: "MAD" }, net: { amount: "0.03", currency: "MAD" }, totalRefunded: null };
    await executeExternalPaymentRefundReference(await reference(f, request.id), { db, provider: { refund: () => Promise.resolve({ ...provider.evidence, settlement }), lookupRefund: () => Promise.resolve({ ...provider.evidence, settlement }) } });
    expect(await admin.externalPaymentRefundSettlement.count({ where: { organizationId: f.org } })).toBe(1);
    expect(await withTenant(db, other.org, tx => tx.externalPaymentRefundSettlement.findMany({ where: { organizationId: f.org } }))).toEqual([]);
    expect(await admin.$queryRaw<Array<{ enabled: boolean; forced: boolean }>>`SELECT relrowsecurity AS enabled,relforcerowsecurity AS forced FROM pg_class WHERE oid='external_payment_refund_settlement'::regclass`).toEqual([{ enabled: true, forced: true }]);
  });
  it("rolls back the reservation when its original attributed audit is absent", async () => {
    const f = await fixture(), input = await draft(f), write = audits.writeAuditEvent; vi.spyOn(audits, "writeAuditEvent").mockImplementation(async (tx, event) => { if (event.action === "finance.external_payment.refund_requested") return undefined; return write(tx, event); });
    await expect(requestExternalPaymentRefund(f.ctx, input, { db })).rejects.toThrow("original refund reservation audit"); expect(await withTenant(db, f.org, tx => new ExternalPaymentRefundRepository(tx, f.org).byKey(input.refund.idempotencyKey))).toBeNull();
  });
  it("preserves forced tenant isolation and denies another organization the retained source", async () => {
    const f = await fixture(), other = await fixture(), input = await draft(f), request = await requestExternalPaymentRefund(f.ctx, input, { db });
    expect(await withTenant(db, other.org, tx => new ExternalPaymentRefundRepository(tx, other.org).find(request.id))).toBeNull();
    await expect(requestExternalPaymentRefund(other.ctx, input, { db })).rejects.toThrow();
  });
  it("forces tenant isolation on every populated refund witness and on reservation totals", async () => {
    const f = await fixture(), other = await fixture(), input = await draft(f), request = await requestExternalPaymentRefund(f.ctx, input, { db });
    await executeExternalPaymentRefundReference(await reference(f, request.id), { db, provider: gateway(f, input) });
    for (const table of ["external_payment_refund_intent", "external_payment_refund_attempt", "external_payment_refund_identity", "external_payment_refund_evidence"]) {
      expect(await admin.$queryRawUnsafe<Array<{ total: number }>>('SELECT count(*)::int AS total FROM "' + table + '" WHERE organization_id=$1::uuid', f.org)).toEqual([{ total: 1 }]);
      expect(await withTenant(db, other.org, tx => tx.$queryRawUnsafe<Array<{ total: number }>>('SELECT count(*)::int AS total FROM "' + table + '" WHERE organization_id=$1::uuid', f.org))).toEqual([{ total: 0 }]);
      expect(await admin.$queryRaw<Array<{ enabled: boolean; forced: boolean }>>`SELECT relrowsecurity AS enabled,relforcerowsecurity AS forced FROM pg_class WHERE oid=${table}::regclass`).toEqual([{ enabled: true, forced: true }]);
    }
    expect(await withTenant(db, other.org, tx => tx.$queryRaw<Array<{ amount: string }>>`SELECT app_external_refund_reserved(${f.org}::uuid,${input.refund.depositId}::uuid)::text AS amount`)).toEqual([{ amount: "0" }]);
  });
  it("protects reserved funds from a competing ordinary bank refund in native PostgreSQL", async () => {
    const f = await fixture(), input = await draft(f, "0.05"); await requestExternalPaymentRefund(f.ctx, input, { db }); const before = await facts(f.org),
      refund = { ...input.refund, accountId: f.banks.refund.id, method: f.receiptInput.method, amount: "0.03" }, review = await reviewGuestDepositRefund(f.ctx, guestDraft(refund), { db });
    await expect(postGuestDepositRefund(f.ctx, { ...refund, idempotencyKey: randomUUID(), reviewFingerprint: review.reviewFingerprint }, { db })).rejects.toThrow("original guest funds are reserved"); expect(await facts(f.org)).toEqual(before);
  });
  it("refuses fabricated manual merchant debits without actual provider refund evidence", async () => {
    const f = await fixture(), input = await draft(f), before = await facts(f.org);
    await expect(postGuestDepositRefund(f.ctx, input.refund, { db })).rejects.toThrow("actual provider merchant refund requires verified durable source"); expect(await facts(f.org)).toEqual(before);
  });
});
function guestDraft(input: Awaited<ReturnType<typeof draft>>["refund"]) { const { idempotencyKey: ignoredKey, reason: ignoredReason, reviewFingerprint: ignoredReview, ...result } = input; void ignoredKey; void ignoredReason; void ignoredReview; return result; }
