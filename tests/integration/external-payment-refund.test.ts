import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { PrismaClient } from "@prisma/client";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { withTenant, type TenantTransaction } from "@/platform/db/tenant";
import { ConfigRuleRepository } from "@/platform/config/config-rule-repository";
import { Money } from "@/platform/money/money";
import * as audits from "@/platform/audit/audit-writer";
import { FinanceRepository } from "@/modules/finance/infrastructure/finance-repository";
import { PaymentMethodRepository } from "@/modules/finance/infrastructure/payment-method-repository";
import { ExternalPaymentRefundRepository } from "@/modules/finance/infrastructure/external-payment-refund-repository";
import { GuestDepositRepository } from "@/modules/finance/infrastructure/guest-deposit-repository";
import { GuestDepositAuthorizationError, GuestDepositSourceError } from "@/modules/finance/domain/guest-deposit";
import { admitExternalPaymentRefund, reviewExternalPaymentRefundAdmission } from "@/modules/finance/application/external-payment-refund-admission";
import { executeExternalPaymentRefundCommand } from "@/modules/finance/application/external-payment-refund-api-service";
import { externalRefundViewSchema } from "@/modules/finance/domain/external-payment-refund-workspace";
import { readGuestDepositWorkspace } from "@/modules/finance/application/guest-deposit-workspace-service";
import { reviewGuestDepositReversal } from "@/modules/finance/application/guest-deposit-service";
import { guestPaymentMethodScopes } from "@/modules/finance/application/guest-deposit-payment-method";
import { inspectGuestDepositReceiptInTransaction, reviewGuestDepositRefund, postGuestDepositRefund } from "@/modules/finance/application/guest-deposit-service";
import { requestExternalPaymentCapture, executeExternalPaymentCaptureReference, externalPaymentCaptureRequested } from "@/modules/finance/application/external-payment-service";
import { reviewCapturedPayPalAdmission } from "@/modules/finance/application/external-payment-workspace-service";
import { admitCapturedPayPalPayment } from "@/modules/finance/application/native-paypal-admission";
import { requestExternalPaymentRefund, executeExternalPaymentRefundReference, externalPaymentRefundRequested, failExternalPaymentRefundReference } from "@/modules/finance/application/external-payment-refund-service";
import { reconcileExternalPaymentRefund, recoverExternalPaymentRefund, getExternalPaymentRefund } from "@/modules/finance/application/external-payment-refund-workspace-service";
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
  it.each([null, "evidenceId", "settlementId", "transactionId", "admittedBy"])("rolls native refund admission back when retained admission evidence is missing or redirected: %s", async field => {
    const f = await fixture(), input = await draft(f), request = await requestExternalPaymentRefund(f.ctx, input, { db }), provider = gateway(f, input), amount = { amount: input.refund.amount, currency: "MAD" },
      settlement = { schemaVersion: 1 as const, basis: "ORIGINAL_PROVIDER_PAYABLE_BREAKDOWN" as const, gross: amount, fee: { amount: "0.00", currency: "MAD" }, net: amount, totalRefunded: amount };
    await executeExternalPaymentRefundReference(await reference(f, request.id), { db, provider: { refund: () => Promise.resolve({ ...provider.evidence, settlement }), lookupRefund: provider.lookupRefund } });
    const review = await reviewExternalPaymentRefundAdmission(f.ctx, { intentId: request.id }, { db }), before = await facts(f.org), write = audits.writeAuditEvent;
    vi.spyOn(audits, "writeAuditEvent").mockImplementation((tx, event) => {
      if (event.action !== "finance.external_payment.refund_admission_evidence") return write(tx, event);
      if (field === null) return Promise.resolve(undefined);
      if (!event.after || typeof event.after !== "object" || Array.isArray(event.after)) throw Error("Actual admission evidence required");
      return write(tx, { ...event, after: { ...event.after, [field]: randomUUID() } });
    });
    await expect(admitExternalPaymentRefund(f.ctx, { intentId: request.id, reviewFingerprint: review.reviewFingerprint }, { db })).rejects.toThrow();
    expect(await facts(f.org)).toEqual(before);
    expect(await withTenant(db, f.org, tx => new GuestDepositRepository(tx, f.org).byCommand(input.refund.idempotencyKey))).toBeNull();
    expect(await withTenant(db, f.org, tx => new ExternalPaymentRefundRepository(tx, f.org).admissionEvidence(request.id))).toBeNull();
  });
  it.each(["PENDING", "FAILED", "CANCELLED", "COMPLETED"] as const)("retains admitted refund history after a later %s observation without settlement", async state => {
    const f = await fixture(), input = await draft(f), request = await requestExternalPaymentRefund(f.ctx, input, { db }), provider = gateway(f, input), ref = await reference(f, request.id), amount = { amount: input.refund.amount, currency: "MAD" },
      settlement = { schemaVersion: 1 as const, basis: "ORIGINAL_PROVIDER_PAYABLE_BREAKDOWN" as const, gross: amount, fee: { amount: "0.00", currency: "MAD" }, net: amount, totalRefunded: amount },
      monetaryPost = vi.fn(() => Promise.resolve({ ...provider.evidence, settlement }));
    await executeExternalPaymentRefundReference(ref, { db, provider: { refund: monetaryPost, lookupRefund: provider.lookupRefund } });
    const review = await reviewExternalPaymentRefundAdmission(f.ctx, { intentId: request.id }, { db }), admitted = await admitExternalPaymentRefund(f.ctx, { intentId: request.id, reviewFingerprint: review.reviewFingerprint }, { db }), recorded = await facts(f.org),
      laterAt = new Date(Date.parse(provider.evidence.updatedAt) + 1000).toISOString(), lookup = vi.fn(() => Promise.resolve({ ...provider.evidence, state, updatedAt: laterAt, refundedAt: state === "COMPLETED" ? laterAt : null, settlement: null }));
    await executeExternalPaymentRefundReference(ref, { db, provider: { refund: monetaryPost, lookupRefund: lookup } });
    expect(monetaryPost).toHaveBeenCalledTimes(1); expect(lookup).toHaveBeenCalledTimes(1); expect(await facts(f.org)).toEqual(recorded);
    const recovered = externalRefundViewSchema.parse((await recoverExternalPaymentRefund(f.ctx, { key: input.refund.idempotencyKey }, { db })).request);
    expect(recovered).toMatchObject({ state: "COMPLETED", refundedAt: provider.evidence.refundedAt, settlement, admission: { transactionId: admitted.id, occurredAt: provider.evidence.refundedAt }, providerObservation: { state, updatedAt: laterAt } });
    expect(externalRefundViewSchema.parse(await getExternalPaymentRefund(f.ctx, { intentId: request.id }, { db }))).toEqual(recovered);
    expect(await withTenant(db, f.org, tx => tx.externalPaymentRefundEvidence.count({ where: { organizationId: f.org, identity: { intentId: request.id } } }))).toBe(2);
    expect(await facts(f.org)).toEqual(recorded);
  });
  it("rolls cancellation back when its attributed witness is missing", async () => {
    const f = await fixture(), input = await draft(f), request = await requestExternalPaymentRefund(f.ctx, input, { db }), before = await facts(f.org), write = audits.writeAuditEvent;
    vi.spyOn(audits, "writeAuditEvent").mockImplementation((tx, event) => event.action === "finance.external_payment.refund_cancelled_before_attempt" ? Promise.resolve(undefined) : write(tx, event));
    await expect(executeExternalPaymentRefundCommand(f.ctx, { operation: "CANCEL", input: { intentId: request.id, reason: "Cancellation must retain its original attributed immutable witness" } }, { db })).rejects.toBeInstanceOf(GuestDepositSourceError);
    expect(await withTenant(db, f.org, tx => new ExternalPaymentRefundRepository(tx, f.org).cancellation(request.id))).toBeNull();
    expect(await withTenant(db, f.org, tx => new ExternalPaymentRefundRepository(tx, f.org).reserved(input.refund.depositId))).toBe("0.03"); expect(await facts(f.org)).toEqual(before);
  });
  it("rechecks current and retained void authority after the actual cancellation write", async () => {
    const f = await fixture(), input = await draft(f), request = await requestExternalPaymentRefund(f.ctx, input, { db }), before = await facts(f.org), write = audits.writeAuditEvent; let revoked = false;
    vi.spyOn(audits, "writeAuditEvent").mockImplementation(async (tx, event) => {
      const result = await write(tx, event);
      if (event.action === "finance.external_payment.refund_cancelled_before_attempt") { if (!("permission" in tx) || !("rolePermission" in tx)) throw Error("Actual native tenant transaction required for revocation");
        const native = tx as unknown as TenantTransaction, permission = await native.permission.findUniqueOrThrow({ where: { organizationId_key: { organizationId: f.org, key: "financial_transaction:void" } } });
        await native.rolePermission.deleteMany({ where: { organizationId: f.org, roleId: f.role.id, permissionId: permission.id } }); revoked = true; }
      return result;
    });
    await expect(executeExternalPaymentRefundCommand(f.ctx, { operation: "CANCEL", input: { intentId: request.id, reason: "Recheck actual cancellation authority after its final audit write" } }, { db })).rejects.toBeInstanceOf(GuestDepositSourceError);
    expect(revoked).toBe(true); expect(await withTenant(db, f.org, tx => new ExternalPaymentRefundRepository(tx, f.org).cancellation(request.id))).toBeNull();
    expect(await withTenant(db, f.org, tx => new ExternalPaymentRefundRepository(tx, f.org).reserved(input.refund.depositId))).toBe("0.03"); expect(await facts(f.org)).toEqual(before);
  });
  it("keeps the first verified economic time in private recovery and admission after later completed provider observations", async () => {
    const f = await fixture(), input = await draft(f), request = await requestExternalPaymentRefund(f.ctx, input, { db }), provider = gateway(f, input), ref = await reference(f, request.id), amount = { amount: input.refund.amount, currency: "MAD" },
      settlement = { schemaVersion: 1 as const, basis: "ORIGINAL_PROVIDER_PAYABLE_BREAKDOWN" as const, gross: amount, fee: { amount: "0.00", currency: "MAD" }, net: amount, totalRefunded: amount };
    await executeExternalPaymentRefundReference(ref, { db, provider: { refund: () => Promise.resolve({ ...provider.evidence, settlement }), lookupRefund: () => Promise.resolve({ ...provider.evidence, settlement }) } });
    const before = await facts(f.org), laterAt = new Date(Date.parse(provider.evidence.updatedAt) + 1000).toISOString();
    await executeExternalPaymentRefundReference(ref, { db, provider: { refund: provider.refund, lookupRefund: () => Promise.resolve({ ...provider.evidence, updatedAt: laterAt, refundedAt: laterAt, settlement }) } });
    expect(await facts(f.org)).toEqual(before);
    expect(externalRefundViewSchema.parse(await getExternalPaymentRefund(f.ctx, { intentId: request.id }, { db })).refundedAt).toBe(provider.evidence.refundedAt);
    const review = await reviewExternalPaymentRefundAdmission(f.ctx, { intentId: request.id }, { db }); expect(review.refundedAt).toBe(provider.evidence.refundedAt);
    const admitted = await admitExternalPaymentRefund(f.ctx, { intentId: request.id, reviewFingerprint: review.reviewFingerprint }, { db }), recorded = await facts(f.org), lastAt = new Date(Date.parse(laterAt) + 1000).toISOString();
    await executeExternalPaymentRefundReference(ref, { db, provider: { refund: provider.refund, lookupRefund: () => Promise.resolve({ ...provider.evidence, updatedAt: lastAt, refundedAt: lastAt, settlement }) } });
    const recovered = externalRefundViewSchema.parse((await recoverExternalPaymentRefund(f.ctx, { key: input.refund.idempotencyKey }, { db })).request);
    expect(recovered).toMatchObject({ refundedAt: provider.evidence.refundedAt, admission: { transactionId: admitted.id, occurredAt: provider.evidence.refundedAt } }); expect(await facts(f.org)).toEqual(recorded);
  });
  it("releases only an unattempted original refund, retains the source, and prevents any later provider POST", async () => {
    const f = await fixture(), input = await draft(f), request = await requestExternalPaymentRefund(f.ctx, input, { db }), before = await facts(f.org), reason = "Cancel this original request before any provider payment attempt";
    const released = externalRefundViewSchema.parse(await executeExternalPaymentRefundCommand(f.ctx, { operation: "CANCEL", input: { intentId: request.id, reason } }, { db }));
    expect(released).toMatchObject({ id: request.id, state: "RELEASED", admission: null, cancellation: { reason }, idempotent: false });
    expect(await withTenant(db, f.org, tx => new ExternalPaymentRefundRepository(tx, f.org).reserved(input.refund.depositId))).toBe("0");
    const provider = gateway(f, input); expect(await executeExternalPaymentRefundReference(await reference(f, request.id), { db, provider })).toMatchObject({ state: "RELEASED" }); expect(provider.refund).not.toHaveBeenCalled(); expect(provider.lookupRefund).not.toHaveBeenCalled();
    await expect(withTenant(db, f.org, tx => new ExternalPaymentRefundRepository(tx, f.org).attempt(request.id))).rejects.toThrow("cancelled original refund cannot start a provider attempt");
    expect(externalRefundViewSchema.parse(await executeExternalPaymentRefundCommand(f.ctx, { operation: "CANCEL", input: { intentId: request.id, reason } }, { db }))).toMatchObject({ state: "RELEASED", idempotent: true });
    expect(await facts(f.org)).toEqual(before);
    const bank = { ...input.refund, accountId: f.banks.refund.id, method: "bank_transfer", amount: "0.07", idempotencyKey: randomUUID() }, review = await reviewGuestDepositRefund(f.ctx, guestDraft(bank), { db });
    expect(await postGuestDepositRefund(f.ctx, { ...bank, reviewFingerprint: review.reviewFingerprint }, { db })).toMatchObject({ operation: "REFUND", depositId: input.refund.depositId });
  });
  it("never releases an unknown original POST outcome or permits a forged cancellation witness", async () => {
    const f = await fixture(), input = await draft(f), request = await requestExternalPaymentRefund(f.ctx, input, { db }), provider = gateway(f, input), reason = "An uncertain payment must remain reserved until independently resolved";
    provider.refund.mockRejectedValueOnce(new Error("retained-original-refund-response-loss")); await expect(executeExternalPaymentRefundReference(await reference(f, request.id), { db, provider })).rejects.toThrow("retained-original-refund-response-loss"); const before = await facts(f.org);
    await expect(executeExternalPaymentRefundCommand(f.ctx, { operation: "CANCEL", input: { intentId: request.id, reason } }, { db })).rejects.toBeInstanceOf(GuestDepositSourceError);
    await expect(withTenant(db, f.org, tx => audits.writeAuditEvent(tx, { organizationId: f.org, actorId: f.account.id, action: "finance.external_payment.refund_cancelled_before_attempt", resourceType: "financial_transaction", resourceId: request.id,
      after: { intentId: request.id, captureId: input.captureId, depositId: input.refund.depositId, idempotencyKey: input.refund.idempotencyKey, amount: { amount: input.refund.amount, currency: input.refund.currency }, disposition: "CANCELLED_BEFORE_PROVIDER_ATTEMPT" }, reason, requestId: randomUUID(), occurredAt: new Date() }))).rejects.toThrow("refund cancellation requires original unattempted durable source");
    expect(await withTenant(db, f.org, tx => new ExternalPaymentRefundRepository(tx, f.org).reserved(input.refund.depositId))).toBe("0.03"); expect(await facts(f.org)).toEqual(before); expect(provider.refund).toHaveBeenCalledTimes(1);
  });
  it("serializes cancellation against the actual provider attempt so only one can win", async () => {
    const f = await fixture(), input = await draft(f), request = await requestExternalPaymentRefund(f.ctx, input, { db }), provider = gateway(f, input), before = await facts(f.org), ref = await reference(f, request.id),
      outcomes = await Promise.allSettled([executeExternalPaymentRefundCommand(f.ctx, { operation: "CANCEL", input: { intentId: request.id, reason: "Race the original queued cancellation against its first provider attempt" } }, { db }), executeExternalPaymentRefundReference(ref, { db, provider })]);
    if (outcomes[0].status === "fulfilled") { expect(outcomes[0].value).toMatchObject({ state: "RELEASED" }); expect(provider.refund).not.toHaveBeenCalled(); expect(await withTenant(db, f.org, tx => new ExternalPaymentRefundRepository(tx, f.org).reserved(input.refund.depositId))).toBe("0"); }
    else { expect(outcomes[0].reason).toBeInstanceOf(GuestDepositSourceError); expect(outcomes[1].status).toBe("fulfilled"); expect(provider.refund).toHaveBeenCalledTimes(1); expect(await withTenant(db, f.org, tx => new ExternalPaymentRefundRepository(tx, f.org).reserved(input.refund.depositId))).toBe("0.03"); }
    expect(await facts(f.org)).toEqual(before);
  });

  it("returns the original durable request and actual admission DTOs without offering a fabricated manual opposite", async () => {
    const f = await fixture(), input = await draft(f), requested = externalRefundViewSchema.parse(await executeExternalPaymentRefundCommand(f.ctx, { operation: "REQUEST", input }, { db }));
    expect(requested).toMatchObject({ idempotencyKey: input.refund.idempotencyKey, input, state: "QUEUED", admission: null, idempotent: false });
    const provider = gateway(f, input), amount = { amount: input.refund.amount, currency: "MAD" }, settlement = { schemaVersion: 1 as const, basis: "ORIGINAL_PROVIDER_PAYABLE_BREAKDOWN" as const, gross: amount, fee: { amount: "0.00", currency: "MAD" }, net: amount, totalRefunded: amount };
    await executeExternalPaymentRefundReference(await reference(f, requested.id), { db, provider: { refund: () => Promise.resolve({ ...provider.evidence, settlement }), lookupRefund: () => Promise.resolve({ ...provider.evidence, settlement }) } });
    const review = await reviewExternalPaymentRefundAdmission(f.ctx, { intentId: requested.id }, { db }), command = { operation: "ADMIT", input: { intentId: requested.id, reviewFingerprint: review.reviewFingerprint } },
      admitted = externalRefundViewSchema.parse(await executeExternalPaymentRefundCommand(f.ctx, command, { db }));
    expect(admitted).toMatchObject({ id: requested.id, idempotencyKey: input.refund.idempotencyKey, state: "COMPLETED", idempotent: false, admission: { state: "ADMITTED", occurredAt: provider.evidence.refundedAt } });
    const detail = await readGuestDepositWorkspace(f.ctx, { operation: "DETAIL", depositId: input.refund.depositId }, { db });
    expect(detail).toMatchObject({ providerCapture: { id: f.captureId, accountId: f.merchant.id, method: input.refund.method } });
    expect("movements" in detail && detail.movements.find(row => row.id === admitted.admission!.transactionId)).toMatchObject({ canReverse: false });
    const before = await facts(f.org); await expect(reviewGuestDepositReversal(f.ctx, { transactionId: admitted.admission!.transactionId }, { db })).rejects.toBeInstanceOf(GuestDepositSourceError);
    expect(externalRefundViewSchema.parse(await executeExternalPaymentRefundCommand(f.ctx, command, { db }))).toMatchObject({ idempotent: true, admission: admitted.admission });
    expect(await facts(f.org)).toEqual(before);
  });
  it.each(["0.03", "0.07"])("admits an actual %s provider refund through the canonical journal at its original economic time", async amount => {
    const f = await fixture(), input = await draft(f, amount), request = await requestExternalPaymentRefund(f.ctx, input, { db }), provider = gateway(f, input),
      settlement = { schemaVersion: 1 as const, basis: "ORIGINAL_PROVIDER_PAYABLE_BREAKDOWN" as const, gross: { amount, currency: "MAD" }, fee: { amount: "0.00", currency: "MAD" }, net: { amount, currency: "MAD" }, totalRefunded: { amount, currency: "MAD" } };
    await executeExternalPaymentRefundReference(await reference(f, request.id), { db, provider: { refund: () => Promise.resolve({ ...provider.evidence, settlement }), lookupRefund: () => Promise.resolve({ ...provider.evidence, settlement }) } });
    const review = await reviewExternalPaymentRefundAdmission(f.ctx, { intentId: request.id }, { db }), admitted = await admitExternalPaymentRefund(f.ctx, { intentId: request.id, reviewFingerprint: review.reviewFingerprint }, { db });
    expect(admitted).toMatchObject({ operation: "REFUND", depositId: input.refund.depositId, idempotent: false });
    const journal = await withTenant(db, f.org, tx => new GuestDepositRepository(tx, f.org).byCommand(input.refund.idempotencyKey));
    expect(journal?.occurredAt.toISOString()).toBe(provider.evidence.refundedAt); expect(journal?.postings.map(row => row.amount.toFixed(2))).toEqual([amount, amount]);
    expect(await withTenant(db, f.org, tx => new ExternalPaymentRefundRepository(tx, f.org).reserved(input.refund.depositId))).toBe("0");
    const before = await facts(f.org); expect(await admitExternalPaymentRefund(f.ctx, { intentId: request.id, reviewFingerprint: review.reviewFingerprint }, { db })).toMatchObject({ id: admitted.id, idempotent: true }); expect(await facts(f.org)).toEqual(before);
  });
  it("retains the original reviewed refund policy when configuration changes after actual provider completion", async () => {
    const f = await fixture(), input = await draft(f), request = await requestExternalPaymentRefund(f.ctx, input, { db }), provider = gateway(f, input),
      settlement = { schemaVersion: 1 as const, basis: "ORIGINAL_PROVIDER_PAYABLE_BREAKDOWN" as const, gross: { amount: "0.03", currency: "MAD" }, fee: { amount: "0.00", currency: "MAD" }, net: { amount: "0.03", currency: "MAD" }, totalRefunded: null };
    await executeExternalPaymentRefundReference(await reference(f, request.id), { db, provider: { refund: () => Promise.resolve({ ...provider.evidence, settlement }), lookupRefund: () => Promise.resolve({ ...provider.evidence, settlement }) } });
    await withTenant(db, f.org, tx => new ConfigRuleRepository(tx, f.org).createVersion({ key: "finance.guest_deposits", scopeType: "organization", effectiveFrom: new Date("2020-01-01"), createdBy: f.account.id, value: f.policy, reason: "Disable future merchant refunds without rewriting actual paid sources" }));
    const review = await reviewExternalPaymentRefundAdmission(f.ctx, { intentId: request.id }, { db }); expect(await admitExternalPaymentRefund(f.ctx, { intentId: request.id, reviewFingerprint: review.reviewFingerprint }, { db })).toMatchObject({ operation: "REFUND" });
  });
  it("rolls back refund admission when final outer audit revokes financial payment authority", async () => {
    const f = await fixture(), input = await draft(f), request = await requestExternalPaymentRefund(f.ctx, input, { db }), provider = gateway(f, input),
      settlement = { schemaVersion: 1 as const, basis: "ORIGINAL_PROVIDER_PAYABLE_BREAKDOWN" as const, gross: { amount: "0.03", currency: "MAD" }, fee: { amount: "0.00", currency: "MAD" }, net: { amount: "0.03", currency: "MAD" }, totalRefunded: null };
    await executeExternalPaymentRefundReference(await reference(f, request.id), { db, provider: { refund: () => Promise.resolve({ ...provider.evidence, settlement }), lookupRefund: () => Promise.resolve({ ...provider.evidence, settlement }) } });
    const review = await reviewExternalPaymentRefundAdmission(f.ctx, { intentId: request.id }, { db }), before = await facts(f.org), write = audits.writeAuditEvent; let revoked = false;
    vi.spyOn(audits, "writeAuditEvent").mockImplementation(async (tx, event) => { await write(tx, event); if (event.action === "finance.external_payment.refund_admitted") { const permission = await admin.permission.findUniqueOrThrow({ where: { organizationId_key: { organizationId: f.org, key: "financial_transaction:pay" } } }); await admin.rolePermission.deleteMany({ where: { organizationId: f.org, roleId: f.role.id, permissionId: permission.id } }); revoked = true; } });
    await expect(admitExternalPaymentRefund(f.ctx, { intentId: request.id, reviewFingerprint: review.reviewFingerprint }, { db })).rejects.toBeInstanceOf(GuestDepositAuthorizationError); expect(revoked).toBe(true); expect(await facts(f.org)).toEqual(before);
    expect(await withTenant(db, f.org, tx => new ExternalPaymentRefundRepository(tx, f.org).reserved(input.refund.depositId))).toBe("0.03");
  });
  it("recovers an original admitted refund after payment authority ends without another movement", async () => {
    const f = await fixture(), input = await draft(f), request = await requestExternalPaymentRefund(f.ctx, input, { db }), provider = gateway(f, input),
      settlement = { schemaVersion: 1 as const, basis: "ORIGINAL_PROVIDER_PAYABLE_BREAKDOWN" as const, gross: { amount: "0.03", currency: "MAD" }, fee: { amount: "0.00", currency: "MAD" }, net: { amount: "0.03", currency: "MAD" }, totalRefunded: null };
    await executeExternalPaymentRefundReference(await reference(f, request.id), { db, provider: { refund: () => Promise.resolve({ ...provider.evidence, settlement }), lookupRefund: () => Promise.resolve({ ...provider.evidence, settlement }) } });
    const review = await reviewExternalPaymentRefundAdmission(f.ctx, { intentId: request.id }, { db }), admitted = await admitExternalPaymentRefund(f.ctx, { intentId: request.id, reviewFingerprint: review.reviewFingerprint }, { db }),
      permission = await admin.permission.findUniqueOrThrow({ where: { organizationId_key: { organizationId: f.org, key: "financial_transaction:pay" } } });
    await admin.rolePermission.deleteMany({ where: { organizationId: f.org, roleId: f.role.id, permissionId: permission.id } }); const before = await facts(f.org);
    expect(await admitExternalPaymentRefund(f.ctx, { intentId: request.id, reviewFingerprint: review.reviewFingerprint }, { db })).toMatchObject({ id: admitted.id, idempotent: true }); expect(await facts(f.org)).toEqual(before);
  });
  it("does not broaden a restricted admission caller with freshly loaded payment grants", async () => {
    const f = await fixture(), input = await draft(f), request = await requestExternalPaymentRefund(f.ctx, input, { db }), provider = gateway(f, input),
      settlement = { schemaVersion: 1 as const, basis: "ORIGINAL_PROVIDER_PAYABLE_BREAKDOWN" as const, gross: { amount: "0.03", currency: "MAD" }, fee: { amount: "0.00", currency: "MAD" }, net: { amount: "0.03", currency: "MAD" }, totalRefunded: null };
    await executeExternalPaymentRefundReference(await reference(f, request.id), { db, provider: { refund: () => Promise.resolve({ ...provider.evidence, settlement }), lookupRefund: () => Promise.resolve({ ...provider.evidence, settlement }) } });
    const review = await reviewExternalPaymentRefundAdmission(f.ctx, { intentId: request.id }, { db }), before = await facts(f.org),
      permissions = (values: ReadonlySet<string>) => new Set([...values].filter(value => value !== "financial_transaction:pay")), restricted = { ...f.ctx, authContext: { ...f.ctx.authContext, permissions: permissions(f.ctx.authContext.permissions),
        assignments: f.ctx.authContext.assignments?.map(assignment => ({ ...assignment, permissions: permissions(assignment.permissions) })) } };
    await expect(admitExternalPaymentRefund(restricted, { intentId: request.id, reviewFingerprint: review.reviewFingerprint }, { db })).rejects.toBeInstanceOf(GuestDepositAuthorizationError); expect(await facts(f.org)).toEqual(before);
  });
  it("refuses a second retained policy witness instead of rewriting the original reviewed source", async () => {
    const f = await fixture(), input = await draft(f), request = await requestExternalPaymentRefund(f.ctx, input, { db }), saved = await withTenant(db, f.org, tx => new GuestDepositRepository(tx, f.org).externalRefundReview(request.id));
    expect(saved).not.toBeNull();
    await expect(withTenant(db, f.org, tx => audits.writeAuditEvent(tx, { organizationId: f.org, actorId: f.account.id, action: "finance.external_payment.refund_review_retained", resourceType: "financial_transaction", resourceId: request.id,
      after: saved!.after, reason: input.refund.reason, requestId: randomUUID(), occurredAt: new Date() }))).rejects.toThrow("one original retained refund policy review required");
    expect(await withTenant(db, f.org, tx => tx.auditLog.count({ where: { organizationId: f.org, resourceId: request.id, action: "finance.external_payment.refund_review_retained" } }))).toBe(1);
  });
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
  it("reconciles an unknown original refund by queued identity GET and recovers its original nonce", async () => {
    const f = await fixture(), input = await draft(f), request = await requestExternalPaymentRefund(f.ctx, input, { db }), ref = await reference(f, request.id), provider = gateway(f, input), before = await facts(f.org);
    provider.refund.mockRejectedValueOnce(new Error("fixture-lost-provider-refund-acknowledgement")); await expect(executeExternalPaymentRefundReference(ref, { db, provider })).rejects.toThrow("fixture-lost-provider-refund-acknowledgement");
    await failExternalPaymentRefundReference(ref, { db }); await failExternalPaymentRefundReference(ref, { db });
    expect(await withTenant(db, f.org, tx => tx.auditLog.count({ where: { organizationId: f.org, resourceId: request.id, action: "finance.external_payment.refund_unconfirmed" } }))).toBe(1);
    expect(await reconcileExternalPaymentRefund(f.ctx, { intentId: request.id, refundId: provider.evidence.refundId }, { db })).toMatchObject({ id: request.id, queued: true });
    const queued = await withTenant(db, f.org, tx => tx.outboxEvent.findFirstOrThrow({ where: { organizationId: f.org, type: externalPaymentRefundRequested, payload: { path: ["refundId"], equals: provider.evidence.refundId } } }));
    expect(await executeExternalPaymentRefundReference({ organizationId: f.org, outboxEventId: queued.id }, { db, provider })).toMatchObject({ state: "COMPLETED", refundId: provider.evidence.refundId });
    expect(provider.refund).toHaveBeenCalledTimes(1); expect(provider.lookupRefund).toHaveBeenCalledTimes(1);
    expect(await recoverExternalPaymentRefund(f.ctx, { key: input.refund.idempotencyKey }, { db })).toMatchObject({ request: { id: request.id, state: "COMPLETED", admission: null } });
    expect(await recoverExternalPaymentRefund(f.ctx, { key: randomUUID() }, { db })).toEqual({ request: null }); expect(await facts(f.org)).toEqual(before);
  });
  it("fences final view revocation on the original private refund read", async () => {
    const f = await fixture(), input = await draft(f), request = await requestExternalPaymentRefund(f.ctx, input, { db }), write = audits.writeAuditEvent;
    vi.spyOn(audits, "writeAuditEvent").mockImplementation(async (tx, event) => { await write(tx, event); if (event.action === "finance.external_payment.refund_viewed") { const permission = await admin.permission.findUniqueOrThrow({ where: { organizationId_key: { organizationId: f.org, key: "financial_transaction:view" } } }); await admin.rolePermission.deleteMany({ where: { organizationId: f.org, roleId: f.role.id, permissionId: permission.id } }); } });
    await expect(getExternalPaymentRefund(f.ctx, { intentId: request.id }, { db })).rejects.toBeInstanceOf(GuestDepositAuthorizationError);
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
    const f = await fixture(), input = await draft(f, "0.05"); await requestExternalPaymentRefund(f.ctx, input, { db }); vi.spyOn(GuestDepositRepository.prototype, "reservedExternalRefunds").mockResolvedValue("0"); const before = await facts(f.org),
      refund = { ...input.refund, accountId: f.banks.refund.id, method: f.receiptInput.method, amount: "0.03" }, review = await reviewGuestDepositRefund(f.ctx, guestDraft(refund), { db });
    await expect(postGuestDepositRefund(f.ctx, { ...refund, idempotencyKey: randomUUID(), reviewFingerprint: review.reviewFingerprint }, { db })).rejects.toThrow("original guest funds are reserved"); expect(await facts(f.org)).toEqual(before);
  });
  it("refuses fabricated manual merchant debits without actual provider refund evidence", async () => {
    const f = await fixture(), input = await draft(f), before = await facts(f.org);
    await expect(postGuestDepositRefund(f.ctx, input.refund, { db })).rejects.toThrow("actual provider merchant refund requires verified durable source"); expect(await facts(f.org)).toEqual(before);
  });
});
function guestDraft(input: Awaited<ReturnType<typeof draft>>["refund"]) { const { idempotencyKey: ignoredKey, reason: ignoredReason, reviewFingerprint: ignoredReview, ...result } = input; void ignoredKey; void ignoredReason; void ignoredReview; return result; }
