import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { PrismaClient } from "@prisma/client";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { withTenant, type TenantTransaction } from "@/platform/db/tenant";
import { authContextForAccount } from "@/platform/authz/account-context";
import * as audits from "@/platform/audit/audit-writer";
import { ExternalPaymentRefundRepository } from "@/modules/finance/infrastructure/external-payment-refund-repository";
import { reviewExternalPaymentRefundSupervision } from "@/modules/finance/application/external-payment-refund-supervision";
import { reviewExternalPaymentRefundAdmission } from "@/modules/finance/application/external-payment-refund-admission";
import { reviewSupervisedExternalPaymentRefundAdmission, admitSupervisedExternalPaymentRefund, recoverSupervisedExternalPaymentRefund } from "@/modules/finance/application/external-payment-refund-supervised-admission";
import { prepareSupervisedExternalPaymentRefundFee, readSupervisedExternalPaymentRefundFee } from "@/modules/finance/application/external-payment-refund-supervised-fee";
import { submitExpense } from "@/modules/finance/application/expense-service";
import { postGuestDepositRefund, inspectGuestDepositRefundInTransaction } from "@/modules/finance/application/guest-deposit-service";
import { issueExternalRefundSupervisionAuthority } from "@/modules/finance/application/external-refund-supervision-authority";
import { nativeTransaction } from "@/modules/finance/application/native-payment-providers";
import { ExternalPaymentRefundError } from "@/modules/finance/domain/external-payment-refund-intent";
import { GuestDepositAuthorizationError } from "@/modules/finance/domain/guest-deposit";
import { guestDepositRefundReviewInput } from "@/modules/finance/domain/guest-deposit-command";
import { actualProviderRefundFeeFixture } from "./support/provider-refund-fixture";
import { provisionIntegrationRole } from "./support/database-role";

let admin: PrismaClient, db: PrismaClient, control: PrismaClient;
beforeAll(async () => {
  const url = process.env.TEST_DATABASE_URL, target = url ? new URL(url) : null;
  if (!target || !["localhost", "127.0.0.1"].includes(target.hostname) || !(target.pathname.startsWith("/alvillas_automation_") || process.env.GITHUB_ACTIONS === "true" && target.pathname === "/alvillas_os")) throw Error("Owned refund-supervision acceptance database required");
  control = new PrismaClient({ datasourceUrl: url }); const database = "alvillas_automation_supervision186_" + randomUUID().replaceAll("-", "").slice(0, 16);
  await control.$executeRawUnsafe('CREATE DATABASE "' + database + '"'); const shadow = new URL(url!); shadow.pathname = "/" + database;
  execFileSync(process.execPath, ["node_modules/prisma/build/index.js", "migrate", "deploy", "--schema", resolve("prisma/schema.prisma")], { env: { ...process.env, DATABASE_URL: shadow.toString() }, stdio: "pipe" });
  admin = new PrismaClient({ datasourceUrl: shadow.toString() }); await provisionIntegrationRole(admin, "alvillas_ops_tests"); const restricted = new URL(shadow); restricted.username = restricted.password = "alvillas_ops_tests"; db = new PrismaClient({ datasourceUrl: restricted.toString() });
  expect(await db.$queryRaw`SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user`).toEqual([{ rolsuper: false, rolbypassrls: false }]);
  await admin.currency.upsert({ where: { code: "MAD" }, update: {}, create: { code: "MAD", name: "MAD", minorUnit: 2 } });
}, 120000);
afterEach(() => vi.restoreAllMocks()); afterAll(async () => { await db?.$disconnect(); await admin?.$disconnect(); await control?.$disconnect(); });
const reason = "Independently review the already-paid original refund after its initiating actor lost access", fixture = () => actualProviderRefundFeeFixture(db, admin),
  facts = (org: string) => withTenant(db, org, tx => tx.$queryRaw<Array<{ kind: string; id: string; xmin: string; body: string }>>`SELECT 'journal' AS kind,id::text,xmin::text,to_jsonb(t)::text AS body FROM financial_transaction t WHERE organization_id=${org}::uuid UNION ALL SELECT 'posting',id::text,xmin::text,to_jsonb(p)::text FROM posting p WHERE organization_id=${org}::uuid ORDER BY kind,id`);
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function reviewer(f: Fixture, permissions = ["financial_transaction:view", "financial_transaction:override", "financial_transaction:reconcile"], propertyId = f.property.id, fundingView = true, fundingPay = false, fundingVoid = false) {
  const selected = await withTenant(db, f.org, async tx => {
    const person = await tx.person.create({ data: { organizationId: f.org, displayName: "Independent financial supervisor" } }), account = await tx.userAccount.create({ data: { organizationId: f.org, personId: person.id } }),
      role = await tx.role.create({ data: { organizationId: f.org, key: "financial_supervisor_" + randomUUID(), name: "Financial supervisor" } }), rows = await tx.permission.findMany({ where: { organizationId: f.org, key: { in: permissions } } });
    expect(rows).toHaveLength(permissions.length); await tx.rolePermission.createMany({ data: rows.map(permission => ({ organizationId: f.org, roleId: role.id, permissionId: permission.id })) });
    await tx.roleAssignment.create({ data: { organizationId: f.org, userAccountId: account.id, personId: person.id, roleId: role.id, scopeType: "property", scopeId: propertyId, validFrom: new Date("2020-01-01") } });
    if (fundingView) {
      const funding = await tx.role.create({ data: { organizationId: f.org, key: "merchant_viewer_" + randomUUID(), name: "Original merchant financial viewer" } }), permission = await tx.permission.findFirstOrThrow({ where: { organizationId: f.org, key: "financial_transaction:view" } });
      await tx.rolePermission.create({ data: { organizationId: f.org, roleId: funding.id, permissionId: permission.id } });
      if (fundingPay) { const pay = await tx.permission.findFirstOrThrow({ where: { organizationId: f.org, key: "financial_transaction:pay" } }); await tx.rolePermission.create({ data: { organizationId: f.org, roleId: funding.id, permissionId: pay.id } }); }
      if (fundingVoid) { const permission = await tx.permission.findFirstOrThrow({ where: { organizationId: f.org, key: "financial_transaction:void" } }); await tx.rolePermission.create({ data: { organizationId: f.org, roleId: funding.id, permissionId: permission.id } }); }
      await tx.roleAssignment.create({ data: { organizationId: f.org, userAccountId: account.id, personId: person.id, roleId: funding.id, scopeType: "financial_record", scopeId: f.merchant.id, validFrom: new Date("2020-01-01") } });
    }
    return { person, account, role };
  });
  return { ...selected, ctx: { organizationId: f.org, actorId: selected.account.id, authContext: { ...await authContextForAccount(f.org, selected.account.id, { db }), personId: selected.person.id } } };
}
describe("independent current financial review of retained provider refunds", () => {
  it("retains the original requester while an independently scoped reviewer records a reasoned view after original access ends", async () => {
    const f = await fixture(), supervisor = await reviewer(f), before = await facts(f.org); await withTenant(db, f.org, tx => tx.roleAssignment.update({ where: { id: f.grant.id }, data: { archivedAt: new Date() } }));
    const result = await reviewExternalPaymentRefundSupervision(supervisor.ctx, { intentId: f.request.id, reason }, { db });
    expect(result).toMatchObject({ intentId: f.request.id, originalRequestedBy: f.account.id, prospectiveAdmitter: supervisor.account.id, amount: { amount: "0.03", currency: "MAD" }, refundedAt: f.evidence.refundedAt, reason }); expect(result.reviewFingerprint).toMatch(/^[a-f0-9]{64}$/u);
    const source = await withTenant(db, f.org, tx => new ExternalPaymentRefundRepository(tx, f.org).find(f.request.id)), review = await withTenant(db, f.org, tx => new ExternalPaymentRefundRepository(tx, f.org).supervisionReview(result.reviewId, supervisor.account.id));
    expect(source?.requestedBy).toBe(f.account.id); expect(review).toMatchObject({ actorId: supervisor.account.id, reason, resourceId: f.request.id }); expect(await facts(f.org)).toEqual(before);
    await expect(reviewExternalPaymentRefundAdmission(f.ctx, { intentId: f.request.id }, { db })).rejects.toThrow(); expect(await facts(f.org)).toEqual(before);
  });
  it.each(["financial_transaction:override", "financial_transaction:reconcile"])("does not infer %s from a financial-supervisor role name", async missing => {
    const f = await fixture(), supervisor = await reviewer(f, ["financial_transaction:view", "financial_transaction:override", "financial_transaction:reconcile"].filter(key => key !== missing)), before = await facts(f.org);
    await expect(reviewExternalPaymentRefundSupervision(supervisor.ctx, { intentId: f.request.id, reason }, { db })).rejects.toBeInstanceOf(ExternalPaymentRefundError);
    expect(await withTenant(db, f.org, tx => tx.auditLog.count({ where: { organizationId: f.org, action: "finance.external_payment.refund_supervision_reviewed" } }))).toBe(0); expect(await facts(f.org)).toEqual(before);
  });
  it("requires independent merchant financial visibility as well as the property financial grants", async () => {
    const f = await fixture(), supervisor = await reviewer(f, undefined, undefined, false), before = await facts(f.org);
    await expect(reviewExternalPaymentRefundSupervision(supervisor.ctx, { intentId: f.request.id, reason }, { db })).rejects.toBeInstanceOf(GuestDepositAuthorizationError);
    expect(await withTenant(db, f.org, tx => tx.auditLog.count({ where: { organizationId: f.org, action: "finance.external_payment.refund_supervision_reviewed" } }))).toBe(0); expect(await facts(f.org)).toEqual(before);
  });
  it("denies unrelated property and tenant scopes before exposing the original paid request", async () => {
    const f = await fixture(), wrong = await reviewer(f, undefined, randomUUID()), before = await facts(f.org);
    await expect(reviewExternalPaymentRefundSupervision(wrong.ctx, { intentId: f.request.id, reason }, { db })).rejects.toBeInstanceOf(GuestDepositAuthorizationError);
    const other = await fixture(), foreign = await reviewer(other); await expect(reviewExternalPaymentRefundSupervision(foreign.ctx, { intentId: f.request.id, reason }, { db })).rejects.toBeInstanceOf(ExternalPaymentRefundError); expect(await facts(f.org)).toEqual(before);
  });
  it("requires the actual immutable review audit before returning a supervisory review receipt", async () => {
    const f = await fixture(), supervisor = await reviewer(f), before = await facts(f.org), write = audits.writeAuditEvent;
    vi.spyOn(audits, "writeAuditEvent").mockImplementation((tx, event) => event.action === "finance.external_payment.refund_supervision_reviewed" ? Promise.resolve(undefined) : write(tx, event));
    await expect(reviewExternalPaymentRefundSupervision(supervisor.ctx, { intentId: f.request.id, reason }, { db })).rejects.toBeInstanceOf(ExternalPaymentRefundError); expect(await facts(f.org)).toEqual(before);
  });
  it("rolls the review audit back after actual final independent override revocation", async () => {
    const f = await fixture(), supervisor = await reviewer(f), before = await facts(f.org), write = audits.writeAuditEvent; let revoked = false;
    vi.spyOn(audits, "writeAuditEvent").mockImplementation(async (tx, event) => { const result = await write(tx, event); if (event.action === "finance.external_payment.refund_supervision_reviewed") {
      if (!("rolePermission" in tx)) throw Error("Actual tenant transaction required"); const native = tx as unknown as TenantTransaction;
      expect((await native.rolePermission.deleteMany({ where: { organizationId: f.org, roleId: supervisor.role.id, permission: { key: "financial_transaction:override" } } })).count).toBe(1); revoked = true;
    } return result; });
    await expect(reviewExternalPaymentRefundSupervision(supervisor.ctx, { intentId: f.request.id, reason }, { db })).rejects.toBeInstanceOf(ExternalPaymentRefundError); expect(revoked).toBe(true);
    expect(await withTenant(db, f.org, tx => tx.auditLog.count({ where: { organizationId: f.org, action: "finance.external_payment.refund_supervision_reviewed" } }))).toBe(0); expect(await facts(f.org)).toEqual(before);
  });
});

const admissionPermissions = ["financial_transaction:view", "financial_transaction:override", "financial_transaction:reconcile", "financial_transaction:pay", "financial_transaction:create"];
const feePermissions = [...admissionPermissions, "financial_transaction:void", "expense:view", "expense:create", "expense:edit", "expense:pay", "expense:void"],
  costAdmitter = (f: Fixture, permissions = feePermissions) => reviewer(f, permissions, undefined, true, true, true);
describe("independent supervised admission of original returned provider costs", () => {
  it.each(["OWNER_PAID", "INCLUDED_IN_COMMISSION"] as const)("keeps original %s cost ownership and ordinary approval while independently admitting exact money", async treatment => {
    const f = await actualProviderRefundFeeFixture(db, admin, treatment), supervisor = await costAdmitter(f), before = await facts(f.org);
    await withTenant(db, f.org, tx => tx.roleAssignment.update({ where: { id: f.grant.id }, data: { archivedAt: new Date() } }));
    const review = await reviewExternalPaymentRefundSupervision(supervisor.ctx, { intentId: f.request.id, reason }, { db }), input = { intentId: f.request.id, reviewId: review.reviewId, reviewFingerprint: review.reviewFingerprint, reason },
      view = await readSupervisedExternalPaymentRefundFee(supervisor.ctx, input, { db }); expect(view).toMatchObject({ returnedFee: { amount: "0.01", currency: "MAD" }, remainingCost: { amount: "0.01", currency: "MAD" }, state: "UNPREPARED" });
    const plan = await prepareSupervisedExternalPaymentRefundFee(supervisor.ctx, input, { db }); expect(plan.expenseId).not.toBeNull(); expect(await facts(f.org)).toEqual(before);
    await expect(reviewSupervisedExternalPaymentRefundAdmission(supervisor.ctx, { intentId: f.request.id, reason }, { db })).rejects.toThrow();
    const draft = await withTenant(db, f.org, tx => tx.expense.findUniqueOrThrow({ where: { organizationId_id: { organizationId: f.org, id: plan.expenseId! } } }));
    expect(draft).toMatchObject({ createdBy: supervisor.account.id, state: "DRAFT", correctsExpenseId: f.fee.id });
    await submitExpense(supervisor.ctx, { id: draft.id, expectedVersion: draft.version, reason: "Apply the frozen original ordinary approval before independent admission" }, { db });
    const approval = await reviewSupervisedExternalPaymentRefundAdmission(supervisor.ctx, { intentId: f.request.id, reason }, { db }), command = admission(approval), result = await admitSupervisedExternalPaymentRefund(supervisor.ctx, command, { db }), after = await facts(f.org);
    expect(after.filter(row => before.some(original => original.kind === row.kind && original.id === row.id))).toEqual(before);
    const added = after.filter(row => row.kind === "journal" && !before.some(original => original.kind === row.kind && original.id === row.id)); expect(added).toHaveLength(3);
    for (const row of added) { const value = JSON.parse(row.body) as { created_by: string; occurred_at: string; sealed: boolean }; expect(value).toMatchObject({ created_by: supervisor.account.id, sealed: true }); expect(new Date(value.occurred_at).toISOString()).toBe(f.evidence.refundedAt); }
    expect(await recoverSupervisedExternalPaymentRefund(supervisor.ctx, { key: command.idempotencyKey }, { db })).toMatchObject({ request: { id: result.id, idempotent: true } }); expect(await facts(f.org)).toEqual(after);
    const binding = await withTenant(db, f.org, tx => tx.externalPaymentRefundFee.findUniqueOrThrow({ where: { organizationId_refundIntentId: { organizationId: f.org, refundIntentId: f.request.id } } })); expect(binding.createdBy).toBe(supervisor.account.id);
    const audits = await withTenant(db, f.org, tx => tx.auditLog.findMany({ where: { organizationId: f.org, action: "finance.external_payment.refund_fee_supervised_prepared" } })); expect(audits).toHaveLength(1); expect(audits[0]).toMatchObject({ actorId: supervisor.account.id, reason, after: { originalRequestedBy: f.account.id, preparedBy: supervisor.account.id, bindingId: binding.id } });
  });
  it("admits a fully credited cost through its exact opposite without a zero-value expense", async () => {
    const f = await actualProviderRefundFeeFixture(db, admin, "OWNER_PAID", "0.02"), supervisor = await costAdmitter(f), before = await facts(f.org), review = await reviewExternalPaymentRefundSupervision(supervisor.ctx, { intentId: f.request.id, reason }, { db }),
      plan = await prepareSupervisedExternalPaymentRefundFee(supervisor.ctx, { intentId: f.request.id, reviewId: review.reviewId, reviewFingerprint: review.reviewFingerprint, reason }, { db }); expect(plan.expenseId).toBeNull();
    const approved = await reviewSupervisedExternalPaymentRefundAdmission(supervisor.ctx, { intentId: f.request.id, reason }, { db }); await admitSupervisedExternalPaymentRefund(supervisor.ctx, admission(approved), { db });
    const after = await facts(f.org); expect(after.filter(row => row.kind === "journal" && !before.some(original => original.kind === row.kind && original.id === row.id))).toHaveLength(2);
    expect(await withTenant(db, f.org, tx => tx.expense.count({ where: { organizationId: f.org, amount: 0 } }))).toBe(0);
  });
  it("requires an independent ordinary expense grant before preparing the original cost", async () => {
    const f = await fixture(), supervisor = await costAdmitter(f, feePermissions.filter(key => key !== "expense:void")), before = await facts(f.org), review = await reviewExternalPaymentRefundSupervision(supervisor.ctx, { intentId: f.request.id, reason }, { db });
    await expect(prepareSupervisedExternalPaymentRefundFee(supervisor.ctx, { intentId: f.request.id, reviewId: review.reviewId, reviewFingerprint: review.reviewFingerprint, reason }, { db })).rejects.toThrow(); expect(await facts(f.org)).toEqual(before);
    expect(await withTenant(db, f.org, tx => tx.externalPaymentRefundFee.count({ where: { organizationId: f.org } }))).toBe(0);
  });
  it("requires its actual supervisory preparation witness in the same native transaction", async () => {
    const f = await fixture(), supervisor = await costAdmitter(f), before = await facts(f.org), review = await reviewExternalPaymentRefundSupervision(supervisor.ctx, { intentId: f.request.id, reason }, { db }), write = audits.writeAuditEvent;
    vi.spyOn(audits, "writeAuditEvent").mockImplementation((tx, event) => event.action === "finance.external_payment.refund_fee_supervised_prepared" ? Promise.resolve(undefined) : write(tx, event));
    await expect(prepareSupervisedExternalPaymentRefundFee(supervisor.ctx, { intentId: f.request.id, reviewId: review.reviewId, reviewFingerprint: review.reviewFingerprint, reason }, { db })).rejects.toThrow(/committed original refund fee/u); expect(await facts(f.org)).toEqual(before);
    expect(await withTenant(db, f.org, tx => tx.externalPaymentRefundFee.count({ where: { organizationId: f.org } }))).toBe(0);
  });
});

const paidWithoutFee = () => actualProviderRefundFeeFixture(db, admin, "OWNER_PAID", "0.00"),
  admitter = (f: Fixture, permissions = admissionPermissions, fundingPay = true) => reviewer(f, permissions, undefined, true, fundingPay),
  admission = (review: { intentId: string; reviewId: string; reviewFingerprint: string; reason: string }) => ({ intentId: review.intentId, reviewId: review.reviewId, reviewFingerprint: review.reviewFingerprint, reason: review.reason, idempotencyKey: randomUUID() });
describe("independently attributed native financial admission of already-paid provider refunds", () => {
  it("records the original fact once under independent authority, preserves prior rows, and recovers a lost response by its new nonce", async () => {
    const f = await paidWithoutFee(), supervisor = await admitter(f), before = await facts(f.org); await withTenant(db, f.org, tx => tx.roleAssignment.update({ where: { id: f.grant.id }, data: { archivedAt: new Date() } }));
    const review = await reviewSupervisedExternalPaymentRefundAdmission(supervisor.ctx, { intentId: f.request.id, reason }, { db }); expect(await facts(f.org)).toEqual(before);
    const input = admission(review), posted = await admitSupervisedExternalPaymentRefund(supervisor.ctx, input, { db }), after = await facts(f.org);
    expect(posted).toMatchObject({ depositId: f.input.receipt.idempotencyKey, operation: "REFUND", idempotent: false }); expect(after.filter(row => before.some(original => original.kind === row.kind && original.id === row.id))).toEqual(before);
    const newRows = after.filter(row => !before.some(original => original.kind === row.kind && original.id === row.id)); expect(newRows.filter(row => row.kind === "journal")).toHaveLength(1); expect(newRows.filter(row => row.kind === "posting")).toHaveLength(2);
    const journal = await withTenant(db, f.org, tx => tx.financialTransaction.findUniqueOrThrow({ where: { organizationId_id: { organizationId: f.org, id: posted.id } } }));
    expect(journal).toMatchObject({ createdBy: supervisor.account.id, sealed: true, occurredAt: new Date(f.evidence.refundedAt), idempotencyKey: "guest-deposit:" + f.refundInput.refund.idempotencyKey });
    const audits = await withTenant(db, f.org, tx => tx.auditLog.findMany({ where: { organizationId: f.org, action: { in: ["finance.guest_deposit.refunded", "finance.external_payment.refund_supervised_admitted"] } } }));
    expect(audits.find(row => row.action === "finance.guest_deposit.refunded")).toMatchObject({ actorId: supervisor.account.id, reason: f.refundInput.refund.reason });
    expect(audits.find(row => row.action === "finance.external_payment.refund_supervised_admitted")).toMatchObject({ actorId: supervisor.account.id, reason, after: { originalRequestedBy: f.account.id, admittedBy: supervisor.account.id, transactionId: posted.id } });
    expect(await withTenant(db, f.org, tx => tx.$queryRaw`SELECT app_external_refund_admission_actor(${f.request.id}::uuid,${f.org}::uuid,${posted.id}::uuid)::text AS actor`)).toEqual([{ actor: supervisor.account.id }]);
    expect(await admitSupervisedExternalPaymentRefund(supervisor.ctx, input, { db })).toMatchObject({ id: posted.id, idempotent: true }); expect(await recoverSupervisedExternalPaymentRefund(supervisor.ctx, { key: input.idempotencyKey }, { db })).toMatchObject({ request: { id: posted.id, idempotent: true } });
    await expect(admitSupervisedExternalPaymentRefund(supervisor.ctx, { ...input, reason: reason + " changed" }, { db })).rejects.toThrow(); expect(await facts(f.org)).toEqual(after);
    expect(await withTenant(db, f.org, tx => tx.externalPaymentRefundAttempt.count({ where: { organizationId: f.org, intentId: f.request.id } }))).toBe(1);
    expect((await withTenant(db, f.org, tx => new ExternalPaymentRefundRepository(tx, f.org).find(f.request.id)))?.requestedBy).toBe(f.account.id);
  });
  it.each(["financial_transaction:pay", "financial_transaction:create"])("requires independent %s in addition to review authority", async missing => {
    const f = await paidWithoutFee(), supervisor = await admitter(f, admissionPermissions.filter(key => key !== missing)), before = await facts(f.org);
    await expect(reviewSupervisedExternalPaymentRefundAdmission(supervisor.ctx, { intentId: f.request.id, reason }, { db })).rejects.toThrow(); expect(await facts(f.org)).toEqual(before);
  });
  it("requires separate actual merchant payment authority", async () => {
    const f = await paidWithoutFee(), supervisor = await admitter(f, undefined, false), before = await facts(f.org);
    await expect(reviewSupervisedExternalPaymentRefundAdmission(supervisor.ctx, { intentId: f.request.id, reason }, { db })).rejects.toThrow(); expect(await facts(f.org)).toEqual(before);
  });
  it("does not substitute a returned-fee cost owner or bypass its ordinary correction approval", async () => {
    const f = await fixture(), supervisor = await admitter(f), before = await facts(f.org);
    await expect(reviewSupervisedExternalPaymentRefundAdmission(supervisor.ctx, { intentId: f.request.id, reason }, { db })).rejects.toBeInstanceOf(ExternalPaymentRefundError); expect(await facts(f.org)).toEqual(before);
  });
  it("requires the financial review to have committed before any native admission", async () => {
    const f = await paidWithoutFee(), supervisor = await admitter(f), before = await facts(f.org);
    await expect(withTenant(db, f.org, async tx => { const runner = nativeTransaction(tx), review = await reviewSupervisedExternalPaymentRefundAdmission(supervisor.ctx, { intentId: f.request.id, reason }, { db: runner }); return admitSupervisedExternalPaymentRefund(supervisor.ctx, admission(review), { db: runner }); })).rejects.toBeInstanceOf(ExternalPaymentRefundError);
    expect(await facts(f.org)).toEqual(before);
  });
  it("rolls back money and both supervisory witnesses if the final durable audit is missing", async () => {
    const f = await paidWithoutFee(), supervisor = await admitter(f), review = await reviewSupervisedExternalPaymentRefundAdmission(supervisor.ctx, { intentId: f.request.id, reason }, { db }), before = await facts(f.org), write = audits.writeAuditEvent;
    vi.spyOn(audits, "writeAuditEvent").mockImplementation((tx, event) => event.action === "finance.external_payment.refund_supervised_admitted" ? Promise.resolve(undefined) : write(tx, event));
    await expect(admitSupervisedExternalPaymentRefund(supervisor.ctx, admission(review), { db })).rejects.toThrow(); expect(await facts(f.org)).toEqual(before);
    expect(await withTenant(db, f.org, tx => tx.auditLog.count({ where: { organizationId: f.org, action: { in: ["finance.external_payment.refund_supervised_authorized", "finance.external_payment.refund_supervised_admitted"] } } }))).toBe(0);
  });
  it("rolls the actual new money and attribution back when the independent override is revoked after the final audit", async () => {
    const f = await paidWithoutFee(), supervisor = await admitter(f), review = await reviewSupervisedExternalPaymentRefundAdmission(supervisor.ctx, { intentId: f.request.id, reason }, { db }), before = await facts(f.org), write = audits.writeAuditEvent; let revoked = false;
    vi.spyOn(audits, "writeAuditEvent").mockImplementation(async (tx, event) => { const result = await write(tx, event); if (event.action === "finance.external_payment.refund_supervised_admitted") {
      const native = tx as unknown as TenantTransaction; expect((await native.rolePermission.deleteMany({ where: { organizationId: f.org, roleId: supervisor.role.id, permission: { key: "financial_transaction:override" } } })).count).toBe(1); revoked = true;
    } return result; });
    await expect(admitSupervisedExternalPaymentRefund(supervisor.ctx, admission(review), { db })).rejects.toBeInstanceOf(ExternalPaymentRefundError); expect(revoked).toBe(true); expect(await facts(f.org)).toEqual(before);
  });
  it("does not treat an in-process token alone as the committed native supervisory witness", async () => {
    const f = await paidWithoutFee(), supervisor = await admitter(f), before = await facts(f.org);
    await expect(withTenant(db, f.org, async tx => {
      const authority = issueExternalRefundSupervisionAuthority({ tx, organizationId: f.org, actorId: supervisor.account.id, intentId: f.request.id, heldContext: supervisor.ctx });
      const draft = { ...f.refundInput.refund, externalReference: f.evidence.refundId }, prepared = await inspectGuestDepositRefundInTransaction(supervisor.ctx, guestDepositRefundReviewInput.strip().parse(draft), tx, { commandKey: f.refundInput.refund.idempotencyKey, supervision: authority });
      return postGuestDepositRefund(supervisor.ctx, { ...draft, reviewFingerprint: prepared.fingerprint }, { db: nativeTransaction(tx), supervision: authority });
    })).rejects.toThrow(/committed verified provider refund/u); expect(await facts(f.org)).toEqual(before);
  });
});
