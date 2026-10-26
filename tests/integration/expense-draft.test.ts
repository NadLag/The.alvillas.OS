import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { PrismaClient, type Prisma } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { provisionIntegrationRole } from "./support/database-role";
import { withTenant } from "@/platform/db/tenant";
import { authContextForAccount } from "@/platform/authz/account-context";
import { ensureStandardIdentitySetup } from "@/modules/identity/application/identity-service";
import { createExpenseDraft, updateExpenseDraft, submitExpense, ExpenseAccessError, ExpenseConflictError } from "@/modules/finance/application/expense-service";
import { getApproval, decideApproval } from "@/platform/approvals/approval-service";
import { ApprovalAccessError, ApprovalConflictError } from "@/platform/approvals/approval";
import { captureReservationCommissionSnapshots } from "@/platform/reservations/finance";
import type { ExpenseDraftInput } from "@/modules/finance/domain/expense";
import { saveAutomationRule, enqueueAutomationEvent, executeAutomationRun, previewAutomation } from "@/platform/automation/service";
import { AutomationRepository } from "@/platform/automation/repository";
import { FinanceRepository } from "@/modules/finance/infrastructure/finance-repository";
import { Money } from "@/platform/money/money";
import { NotificationRepository } from "@/platform/notifications/notification-repository";
import { resolveNotificationChannel } from "@/platform/notifications/notification-channel-service";
import { defaultNotificationPreferences } from "@/platform/notifications/notification-preferences";
import { authorize } from "@/platform/authz/authorize";
import { ExpenseRepository } from "@/modules/finance/infrastructure/expense-repository";
import { presentAuditHistoryRow } from "@/modules/audit/application/audit-service";
import { AuditRepository } from "@/modules/audit/infrastructure/audit-repository";
import { maskedValue } from "@/platform/authz/present";
import { ConfigRuleRepository } from "@/platform/config/config-rule-repository";
import { evaluateExpensePolicy } from "@/modules/finance/application/finance-config-service";

const url = process.env.TEST_DATABASE_URL;
let admin: PrismaClient, db: PrismaClient;
async function fixture() {
  const org = randomUUID(); await admin.organization.create({ data: { id: org, name: "Dedicated native expense integration", baseCurrency: "MAD" } });
  await ensureStandardIdentitySetup(org, { db });
  return withTenant(db, org, async tx => {
    await tx.currency.upsert({ where: { code: "MAD" }, update: {}, create: { code: "MAD", name: "Dirham", minorUnit: 2 } });
    const person = await tx.person.create({ data: { organizationId: org, displayName: "Dedicated expense operator" } });
    const account = await tx.userAccount.create({ data: { organizationId: org, personId: person.id } });
    const property = await tx.property.create({ data: { organizationId: org, name: "Dedicated expense villa", addressLine1: "Local integration",
      city: "Marrakech", propertyType: "VILLA", bedrooms: 1, bathrooms: 1, maxGuests: 2, amenities: [], photoUrls: [] } });
    const bank = await tx.ledgerAccount.create({ data: { organizationId: org, code: "DEDICATED_EXPENSE_BANK", name: "Dedicated local bank", accountType: "ASSET_LOCATION", normalSide: "DEBIT" } });
    const role = await tx.role.create({ data: { organizationId: org, key: "expense_operator", name: "Dedicated expense author" } });
    const auditRole = await tx.role.create({ data: { organizationId: org, key: "expense_auditor", name: "Independent audit access" } });
    for (const [subject, keys] of [[role, ["expense:create", "expense:view", "expense:edit", "financial_transaction:view"]], [auditRole, ["audit_log:view", "audit_log:export"]]] as const) {
      const permissions = await tx.permission.findMany({ where: { key: { in: [...keys] } } }); expect(permissions).toHaveLength(keys.length);
      await tx.rolePermission.createMany({ data: permissions.map(permission => ({ organizationId: org, roleId: subject.id, permissionId: permission.id })) });
    }
    const grant = await tx.roleAssignment.create({ data: { organizationId: org, roleId: role.id, userAccountId: account.id, personId: person.id,
      scopeType: "property", scopeId: property.id, validFrom: new Date("2020-01-01") } });
    await tx.roleAssignment.create({ data: { organizationId: org, roleId: auditRole.id, userAccountId: account.id, personId: person.id,
      scopeType: "organization", validFrom: new Date("2020-01-01") } });
    const input = { propertyId: property.id, amount: "500.25", currency: "MAD", category: "maintenance", purpose: "Dedicated fictional repair",
      occurredOn: "2026-10-26", fundingAccountId: bank.id, emergency: false, idempotencyKey: randomUUID(), reason: "Dedicated native expense draft" };
    return { org, account, person, property, bank, grant, input };
  });
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function actor(f: Fixture) { return { organizationId: f.org, actorId: f.account.id,
  authContext: { ...await authContextForAccount(f.org, f.account.id, { db }), personId: f.person.id } }; }
const create = async (f: Fixture, input: ExpenseDraftInput = f.input) => createExpenseDraft(await actor(f), input, { db });
async function policy(f: Fixture, approval: Prisma.InputJsonObject = { thresholds: [] }) {
  return withTenant(db, f.org, async tx => {
    const owner = await tx.owner.create({ data: { organizationId: f.org, displayName: "Dedicated expense owner" } });
    await tx.propertyOwner.create({ data: { organizationId: f.org, propertyId: f.property.id, ownerId: owner.id } });
    const rules = new ConfigRuleRepository(tx, f.org);
    const allocation = await rules.createVersion({ key: "finance.expense_treatment", scopeType: "property", scopeId: f.property.id,
      effectiveFrom: new Date("2020-01-01"), reason: "Dedicated expense treatment", value: { default_treatment: "OWNER_PAID" } });
    await rules.createVersion({ key: "finance.approval_thresholds", scopeType: "property", scopeId: f.property.id,
      effectiveFrom: new Date("2020-01-01"), reason: "Dedicated explicit approval policy", value: approval });
    return { owner, allocation };
  });
}
async function approver(f: Fixture, scopeType: "property" | "owner", scopeId: string, financial = true) {
  const identity = await withTenant(db, f.org, async tx => {
    const person = await tx.person.create({ data: { organizationId: f.org, displayName: "Dedicated approval reviewer" } });
    const account = await tx.userAccount.create({ data: { organizationId: f.org, personId: person.id, email: `reviewer-${randomUUID()}@example.test` } });
    const role = await tx.role.create({ data: { organizationId: f.org, key: `dedicated_approval_${randomUUID()}`, name: "Dedicated scoped reviewer" } });
    const keys = financial ? ["expense:view", "expense:approve", "expense:reject"] : ["property:view", "property:approve", "property:reject"];
    const permissions = await tx.permission.findMany({ where: { key: { in: keys } } }); expect(permissions).toHaveLength(keys.length);
    await tx.rolePermission.createMany({ data: permissions.map(permission => ({ organizationId: f.org, roleId: role.id, permissionId: permission.id })) });
    const grant = await tx.roleAssignment.create({ data: { organizationId: f.org, roleId: role.id, userAccountId: account.id, personId: person.id,
      scopeType, scopeId, validFrom: new Date("2020-01-01") } });
    return { person, account, grant };
  });
  return { ...identity, actor: { organizationId: f.org, accountId: identity.account.id, authContext: await authContextForAccount(f.org, identity.account.id, { db }) } };
}

describe("native expenses on real PostgreSQL", () => {
  beforeAll(async () => {
    if (!url || !["localhost", "127.0.0.1"].includes(new URL(url).hostname)) throw new Error("Local PostgreSQL is required");
    execFileSync(process.execPath, ["node_modules/prisma/build/index.js", "migrate", "deploy"], { env: { ...process.env, DATABASE_URL: url }, stdio: "pipe" });
    admin = new PrismaClient({ datasourceUrl: url }); await provisionIntegrationRole(admin, "alvillas_ops_tests");
    const scoped = new URL(url); scoped.username = "alvillas_ops_tests"; scoped.password = "alvillas_ops_tests"; db = new PrismaClient({ datasourceUrl: scoped.toString() });
  });
  afterAll(async () => { await db?.$disconnect(); await admin?.$disconnect(); });
  it.each(["behind","ahead"] as const)("uses PostgreSQL grant validity when the application clock is %s", async direction => {
    const f = await fixture();
    const at = await withTenant(db, f.org, async tx => {
      const clock = (await tx.$queryRaw<Array<{ at: Date }>>`SELECT clock_timestamp() AS at`)[0].at;
      await tx.roleAssignment.update({ where: { id: f.grant.id }, data: { validFrom: new Date(clock.getTime()-60_000) } });
      const role = await tx.role.create({ data: { organizationId: f.org, key: "future_expense_approver", name: "Future approval grant" } });
      const permission = await tx.permission.findFirstOrThrow({ where: { key: "expense:approve" } });
      await tx.rolePermission.create({ data: { organizationId: f.org, roleId: role.id, permissionId: permission.id } });
      await tx.roleAssignment.create({ data: { organizationId: f.org, roleId: role.id, userAccountId: f.account.id, personId: f.person.id,
        scopeType: "property", scopeId: f.property.id, validFrom: new Date(clock.getTime()+60_000) } });
      return clock;
    });
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date(at.getTime()+(direction === "behind" ? -600_000 : 600_000)));
    try {
      const ctx = await authContextForAccount(f.org,f.account.id,{ db });
      expect(ctx.permissions.has("expense:edit")).toBe(true); expect(ctx.permissions.has("expense:approve")).toBe(false);
      expect(authorize(ctx,"edit",{ type:"expense",organizationId:f.org,propertyId:f.property.id,amount:f.input.amount },at)).toBe(true);
    } finally { vi.useRealTimers(); }
  });
  it("creates an audited unposted draft once across concurrent original-key retries", async () => {
    const f = await fixture(), results = await Promise.all([create(f), create(f)]);
    expect(results.map(result => result.idempotent).sort()).toEqual([false,true]); expect(results[0].id).toBe(results[1].id);
    await withTenant(db, f.org, async tx => {
      expect(await tx.expense.count()).toBe(1); expect(await tx.auditLog.count({ where: { action: "expense.created" } })).toBe(1);
      expect(await tx.financialTransaction.count()).toBe(0); expect(await tx.outboxEvent.count({ where: { type: "ExpenseSubmitted" } })).toBe(0);
      expect(await tx.expense.findFirstOrThrow()).toMatchObject({ state: "DRAFT", version: 1, transactionId: null });
    });
    await expect(create(f, { ...f.input, amount: "600" })).rejects.toBeInstanceOf(ExpenseConflictError);
  });
  it("submits one immutable native event and policy snapshot across concurrent retries without posting money", async () => {
    const f = await fixture(), configured = await policy(f), draft = await create(f), ctx = await actor(f);
    const input = { id: draft.id, expectedVersion: draft.version, reason: "Dedicated original native submission" };
    const submitted = await Promise.all([submitExpense(ctx, input, { db }), submitExpense(ctx, input, { db })]);
    expect(submitted.map(row => row.idempotent).sort()).toEqual([false,true]); expect(submitted[0]).toMatchObject({ state: "APPROVED", version: 3, approvalId: null });
    await expect(submitExpense(ctx, { ...input, reason: "Changed submission retry reason" }, { db })).rejects.toBeInstanceOf(ExpenseConflictError);
    await withTenant(db, f.org, async tx => {
      expect(await tx.expenseSubmission.count()).toBe(1); expect(await tx.outboxEvent.count({ where: { type: "ExpenseSubmitted" } })).toBe(1);
      expect(await tx.outboxEvent.count({ where: { type: "ExpenseOverThreshold" } })).toBe(0); expect(await tx.financialTransaction.count()).toBe(0);
      expect(await tx.auditLog.count({ where: { action: "expense.submitted" } })).toBe(1);
      const snapshot = await tx.expenseSubmission.findFirstOrThrow();
      expect(snapshot.snapshot).toMatchObject({ sourceExpenseVersion: 1, amount: { amount: "500.25", currency: "MAD" },
        policies: [{ ownerId: configured.owner.id, allocationRule: { configRuleId: configured.allocation.id, version: 1 } }], stages: [] });
    });
  });
  it("fails closed on unconfigured financial routing without creating submission, approval or event rows", async () => {
    const f = await fixture(); await policy(f, { thresholds: [{ key: "requires_owner", requires_approval_from: ["owner"] }] });
    const draft = await create(f); await expect(submitExpense(await actor(f), { id: draft.id, expectedVersion: 1, reason: "Dedicated missing routing rejection" }, { db })).rejects.toThrow();
    await withTenant(db, f.org, async tx => {
      expect(await tx.expenseSubmission.count()).toBe(0); expect(await tx.approvalRequest.count()).toBe(0);
      expect(await tx.outboxEvent.count({ where: { type: "ExpenseSubmitted" } })).toBe(0); expect(await tx.expense.findFirstOrThrow()).toMatchObject({ state: "DRAFT", version: 1 });
    });
  });
  it("uses actual owner period revenue without cancelling it against the receipt's bank debit", async () => {
    const f = await fixture(); await policy(f); const reviewer = await approver(f, "property", f.property.id);
    await withTenant(db, f.org, async tx => {
      const finance = new FinanceRepository(tx, f.org), payable = await finance.ensureLedgerAccount({ code: "OWNER_PAYABLE", name: "Owner payable", accountType: "CLAIM_OWNERSHIP", normalSide: "CREDIT" });
      await finance.createFinancialTransaction({ reference: "Dedicated source revenue", occurredAt: new Date("2026-10-15T12:00:00Z"), description: "Dedicated period revenue receipt", idempotencyKey: randomUUID(), createdBy: f.account.id,
        postings: [{ ledgerAccountId: f.bank.id, side: "DEBIT", amount: Money.of("1000","MAD"), bucket: "OWNER_REVENUE", dimensions: { property_id: f.property.id } },
          { ledgerAccountId: payable.id, side: "CREDIT", amount: Money.of("1000","MAD"), bucket: "OWNER_REVENUE", dimensions: { property_id: f.property.id } }] });
      await new ConfigRuleRepository(tx, f.org).createVersion({ key: "finance.approval_thresholds", scopeType: "property", scopeId: f.property.id,
        effectiveFrom: new Date("2020-01-02"), reason: "Dedicated revenue percentage approval", value: { revenue_period: { unit: "MONTH" },
          thresholds: [{ key: "revenue_percentage", percentage_of_revenue_bps: 6000, requires_approval_from: ["manager"] }],
          routing: { manager: { people: [reviewer.person.id], roles: [], assigned: false, channels: ["in_app"] } } } });
    });
    const below = await create(f), low = await submitExpense(await actor(f), { id: below.id, expectedVersion: 1, reason: "Dedicated below revenue threshold" }, { db });
    expect(low.state).toBe("APPROVED"); expect(low.approvalId).toBeNull();
    const above = await create(f, { ...f.input, amount: "800", idempotencyKey: randomUUID() });
    expect((await submitExpense(await actor(f), { id: above.id, expectedVersion: 1, reason: "Dedicated above revenue threshold" }, { db })).state).toBe("PENDING_APPROVAL");
    await withTenant(db, f.org, async tx => {
      const snapshot = await tx.expenseSubmission.findUniqueOrThrow({ where: { organizationId_expenseId: { organizationId: f.org, expenseId: below.id } } });
      expect(snapshot.snapshot).toMatchObject({ policies: [{ revenueEvidence: { amount: { amount: "1000.00", currency: "MAD" } } }] });
    });
  });
  it("orders manager then owner decisions and rechecks financial grants independently from operational approval access", async () => {
    const f = await fixture(), configured = await policy(f), manager = await approver(f, "property", f.property.id), owner = await approver(f, "owner", configured.owner.id), operations = await approver(f, "property", f.property.id, false);
    const routing = (people: string[]) => ({ people, roles: [], assigned: false, channels: ["in_app"] });
    await withTenant(db, f.org, tx => new ConfigRuleRepository(tx, f.org).createVersion({ key: "finance.approval_thresholds", scopeType: "property", scopeId: f.property.id,
      effectiveFrom: new Date("2020-01-02"), reason: "Dedicated ordered financial approval", value: { thresholds: [{ key: "expense_amount", amount: "100", currency: "MAD", requires_approval_from: ["manager_owner"] }],
        routing: { manager: routing([manager.person.id, operations.person.id]), owner: routing([owner.person.id]) } } }));
    const draft = await create(f), submitted = await submitExpense(await actor(f), { id: draft.id, expectedVersion: 1, reason: "Dedicated ordered native submission" }, { db });
    expect(submitted.state).toBe("PENDING_APPROVAL"); expect(submitted.approvalId).toBeTruthy();
    const requestId = submitted.approvalId!, stages = await withTenant(db, f.org, tx => tx.approvalStage.findMany({ where: { approvalId: requestId }, orderBy: { position: "asc" } }));
    expect(stages.map(stage => stage.kind)).toEqual(["manager","owner"]);
    const originalNotice = await withTenant(db, f.org, async tx => {
      const notifications = new NotificationRepository(tx, f.org), defaults = defaultNotificationPreferences();
      await notifications.savePreferences(manager.account.id, { ...defaults, email: { ...defaults.email, enabled: true, operations: true } });
      const event = await tx.outboxEvent.findUniqueOrThrow({ where: { organizationId_idempotencyKey: { organizationId: f.org, idempotencyKey: `approval:${requestId}:stage:${stages[0].id}:requested` } } });
      expect((await resolveNotificationChannel(notifications, { kind: "approval_requested", channel: "email", recipientId: manager.account.id, targetId: requestId, sourceEventId: event.id })).allowed).toBe(true);
      return event.id;
    });
    await expect(withTenant(db, f.org, tx => tx.approvalStage.update({ where: { id: stages[1].id }, data: { state: "APPROVED", decidedBy: owner.account.id,
      decidedAt: new Date(), decisionReason: "Dedicated raw unordered decision" } }))).rejects.toThrow("ordered recipient");
    await expect(withTenant(db, f.org, tx => tx.approvalRecipient.create({ data: { organizationId: f.org, approvalId: requestId, userAccountId: operations.account.id } }))).rejects.toThrow("audience must match");
    expect((await getApproval(manager.actor, requestId, { db })).canApprove).toBe(true); expect((await getApproval(owner.actor, requestId, { db })).canApprove).toBe(false);
    await expect(getApproval(operations.actor, requestId, { db })).rejects.toBeInstanceOf(ApprovalAccessError);
    await expect(decideApproval(owner.actor, { id: requestId, stageId: stages[1].id, decision: "APPROVED", reason: "Dedicated premature owner decision" }, { db })).rejects.toBeInstanceOf(ApprovalConflictError);
    await expect(decideApproval(manager.actor, { id: requestId, decision: "APPROVED", reason: "Dedicated omitted stage identifier" }, { db })).rejects.toBeInstanceOf(ApprovalAccessError);
    const decision = { id: requestId, stageId: stages[0].id, decision: "APPROVED", reason: "Dedicated manager review accepted" };
    await Promise.all([decideApproval(manager.actor, decision, { db }), decideApproval(manager.actor, decision, { db })]);
    await withTenant(db, f.org, async tx => {
      expect((await resolveNotificationChannel(new NotificationRepository(tx, f.org), { kind: "approval_requested", channel: "email", recipientId: manager.account.id, targetId: requestId, sourceEventId: originalNotice })).allowed).toBe(false);
    });
    expect((await getApproval(owner.actor, requestId, { db })).canApprove).toBe(true);
    await withTenant(db, f.org, tx => tx.roleAssignment.update({ where: { id: owner.grant.id }, data: { validTo: new Date() } }));
    await expect(decideApproval(owner.actor, { id: requestId, stageId: stages[1].id, decision: "APPROVED", reason: "Dedicated stale grant must be denied" }, { db })).rejects.toBeInstanceOf(ApprovalAccessError);
    await withTenant(db, f.org, tx => tx.roleAssignment.update({ where: { id: owner.grant.id }, data: { validTo: null } }));
    await decideApproval(owner.actor, { id: requestId, stageId: stages[1].id, decision: "APPROVED", reason: "Dedicated owner review accepted" }, { db });
    await withTenant(db, f.org, async tx => {
      expect(await tx.expense.findFirstOrThrow()).toMatchObject({ state: "APPROVED", version: 3, transactionId: null });
      expect(await tx.auditLog.count({ where: { action: "expense.approval_stage_decided" } })).toBe(2);
      expect(await tx.outboxEvent.count({ where: { type: "ExpenseOverThreshold" } })).toBe(1); expect(await tx.outboxEvent.count({ where: { type: "ApprovalDecided" } })).toBe(1);
      expect(await tx.notification.count({ where: { recipientId: operations.account.id } })).toBe(0); expect(await tx.financialTransaction.count()).toBe(0);
      const notice = await tx.notification.findFirstOrThrow({ where: { recipientId: owner.account.id, targetId: requestId } });
      expect(notice.resolution).toBe("APPROVED");
      const target = (await new NotificationRepository(tx, f.org).targets([notice], owner.account.id)).get(requestId);
      expect(target?.ownerId).toBe(configured.owner.id); expect(authorize(owner.actor.authContext, "view", target!)).toBe(true);
    });
  });
  it("uses original reservation agreement treatments after ownership and configuration change", async () => {
    const f = await fixture(), configured = await policy(f);
    const reservation = await withTenant(db, f.org, async tx => {
      await new ConfigRuleRepository(tx, f.org).createVersion({ key: "finance.commission", scopeType: "property", scopeId: f.property.id,
        effectiveFrom: new Date("2020-01-01"), reason: "Dedicated original reservation agreement", value: { rate_bps: 2000, basis: "GROSS_ACCOMMODATION", accrual_event: "ON_RECEIPT",
          expense_treatments: { default_treatment: "ALVILLAS_PAID" }, approval_thresholds: { thresholds: [] } } });
      const reservation = await tx.reservation.create({ data: { organizationId: f.org, propertyId: f.property.id, reference: randomUUID(), source: "DIRECT", status: "CONFIRMED",
        guestName: "Dedicated historical expense guest", checkIn: new Date("2026-10-26"), checkOut: new Date("2026-10-28"), nights: 2, idempotencyKey: randomUUID(), confirmedAt: new Date("2026-10-20") } });
      await captureReservationCommissionSnapshots(tx, f.org, reservation.id, f.account.id);
      await tx.propertyOwner.updateMany({ where: { propertyId: f.property.id }, data: { archivedAt: new Date() } });
      const newOwner = await tx.owner.create({ data: { organizationId: f.org, displayName: "Dedicated subsequent owner" } });
      await tx.propertyOwner.create({ data: { organizationId: f.org, propertyId: f.property.id, ownerId: newOwner.id } });
      await new ConfigRuleRepository(tx, f.org).createVersion({ key: "finance.commission", scopeType: "property", scopeId: f.property.id,
        effectiveFrom: new Date("2026-10-21"), reason: "Dedicated changed reservation agreement", value: { rate_bps: 2500, basis: "GROSS_ACCOMMODATION", accrual_event: "ON_RECEIPT",
          expense_treatments: { default_treatment: "OWNER_PAID" }, approval_thresholds: { thresholds: [] } } });
      return reservation;
    });
    const draft = await create(f, { ...f.input, reservationId: reservation.id }); await submitExpense(await actor(f), { id: draft.id, expectedVersion: 1, reason: "Dedicated historical native submission" }, { db });
    const snapshot = await withTenant(db, f.org, tx => tx.expenseSubmission.findFirstOrThrow());
    expect(snapshot.snapshot).toMatchObject({ policies: [{ ownerId: configured.owner.id, allocationRule: { version: 1 }, allocation: { treatment: "ALVILLAS_PAID" } }],
      allocation: { owner: { amount: "0.00", currency: "MAD" }, alvillas: { amount: "500.25", currency: "MAD" } } });
  });
  it("captures separate owner policies and condition references at confirmation without substituting later versions", async () => {
    const f = await fixture(), configured = await policy(f);
    const original = await withTenant(db, f.org, async tx => {
      const rules = new ConfigRuleRepository(tx, f.org);
      await rules.createVersion({ key: "finance.commission", scopeType: "property", scopeId: f.property.id, effectiveFrom: new Date("2020-01-01"),
        reason: "Dedicated ordinary commission configuration", value: { rate_bps: 2000, basis: "GROSS_ACCOMMODATION", accrual_event: "ON_RECEIPT" } });
      const treatment = await rules.createVersion({ key: "finance.expense_treatment", scopeType: "owner", scopeId: configured.owner.id, effectiveFrom: new Date("2020-01-01"),
        reason: "Dedicated original owner expense configuration", value: { default_treatment: "ALVILLAS_PAID" } });
      // A property policy outranks the owner fallback; retain its exact version.
      const propertyTreatment = await rules.createVersion({ key: "finance.expense_treatment", scopeType: "property", scopeId: f.property.id, effectiveFrom: new Date("2020-01-02"),
        reason: "Dedicated original property expense configuration", value: { default_treatment: "ALVILLAS_PAID" } });
      const reference = await rules.createVersion({ key: "finance.payout_schedule", scopeType: "property", scopeId: f.property.id, effectiveFrom: new Date("2020-01-01"),
        reason: "Dedicated original approval reference", value: { cadence: "MONTHLY", holdback_amount: "600", holdback_currency: "MAD" } });
      await rules.createVersion({ key: "finance.approval_thresholds", scopeType: "property", scopeId: f.property.id, effectiveFrom: new Date("2020-01-02"),
        reason: "Dedicated original condition policy", value: { thresholds: [{ key: "saved_reference", conditions: { path: "expense.amount", op: ">", value: { config: "finance.payout_schedule", path: "holdback_amount" } }, requires_approval_from: ["owner"] }] } });
      const reservation = await tx.reservation.create({ data: { organizationId: f.org, propertyId: f.property.id, reference: randomUUID(), source: "DIRECT", status: "CONFIRMED",
        guestName: "Dedicated original policy guest", checkIn: new Date("2026-10-26"), checkOut: new Date("2026-10-28"), nights: 2, idempotencyKey: randomUUID(), confirmedAt: new Date("2026-10-20") } });
      await captureReservationCommissionSnapshots(tx, f.org, reservation.id, f.account.id);
      const before = await tx.commissionSnapshot.findFirstOrThrow({ where: { reservationId: reservation.id } });
      await rules.createVersion({ key: "finance.payout_schedule", scopeType: "property", scopeId: f.property.id, effectiveFrom: new Date("2026-10-21"),
        reason: "Dedicated changed reference after confirmation", value: { cadence: "MONTHLY", holdback_amount: "100", holdback_currency: "MAD" } });
      await rules.createVersion({ key: "finance.expense_treatment", scopeType: "property", scopeId: f.property.id, effectiveFrom: new Date("2026-10-21"),
        reason: "Dedicated changed treatment after confirmation", value: { default_treatment: "OWNER_PAID" } });
      return { reservation, before, reference, treatment, propertyTreatment };
    });
    const draft = await create(f, { ...f.input, reservationId: original.reservation.id });
    expect((await submitExpense(await actor(f), { id: draft.id, expectedVersion: 1, reason: "Dedicated frozen reference submission" }, { db })).state).toBe("APPROVED");
    await withTenant(db, f.org, async tx => {
      const snapshot = await tx.expenseSubmission.findFirstOrThrow();
      expect(snapshot.snapshot).toMatchObject({ policies: [{ allocationRule: { configRuleId: original.propertyTreatment.id, version: original.propertyTreatment.version },
        configReferences: [{ configRuleId: original.reference.id, version: 1 }] }], allocation: { alvillas: { amount: "500.25", currency: "MAD" }, owner: { amount: "0.00", currency: "MAD" } } });
      expect((await tx.commissionSnapshot.findUniqueOrThrow({ where: { id: original.before.id } })).snapshotValue).toEqual(original.before.snapshotValue);
    });
  });
  it("does not bypass an owner approval while the required emergency notification workflow is unavailable", async () => {
    const f = await fixture(); await policy(f, { thresholds: [{ key: "emergency", emergency_bypass_owner: true, requires_approval_from: ["owner"] }] });
    const draft = await create(f, { ...f.input, emergency: true });
    await expect(submitExpense(await actor(f), { id: draft.id, expectedVersion: 1, reason: "Dedicated emergency notification dependency" }, { db })).rejects.toThrow("post-hoc owner notification");
    await withTenant(db, f.org, async tx => {
      expect(await tx.expense.findFirstOrThrow()).toMatchObject({ state: "DRAFT", version: 1 }); expect(await tx.expenseSubmission.count()).toBe(0);
      expect(await tx.outboxEvent.count({ where: { type: "ExpenseSubmitted" } })).toBe(0); expect(await tx.financialTransaction.count()).toBe(0);
    });
  });
  it("evaluates requester roles by current resource scope independently of the separate expense author permission", async () => {
    const f = await fixture(); await policy(f); const reviewer = await approver(f, "property", f.property.id);
    const trait = await withTenant(db, f.org, async tx => {
      const role = await tx.role.create({ data: { organizationId: f.org, key: "dedicated_requester_role", name: "Dedicated scoped requester role" } });
      const permission = await tx.permission.findFirstOrThrow({ where: { key: "property:view" } });
      await tx.rolePermission.create({ data: { organizationId: f.org, roleId: role.id, permissionId: permission.id } });
      const assignment = await tx.roleAssignment.create({ data: { organizationId: f.org, roleId: role.id, userAccountId: f.account.id, personId: f.person.id,
        scopeType: "property", scopeId: f.property.id, validFrom: new Date("2020-01-01") } });
      await new ConfigRuleRepository(tx, f.org).createVersion({ key: "finance.approval_thresholds", scopeType: "property", scopeId: f.property.id,
        effectiveFrom: new Date("2020-01-02"), reason: "Dedicated scoped requester condition", value: { thresholds: [{ key: "requester_role", conditions: { path: "actor.roles", op: "contains", value: role.key }, requires_approval_from: ["manager"] }],
          routing: { manager: { people: [reviewer.person.id], roles: [], assigned: false, channels: ["in_app"] } } } });
      return assignment;
    });
    const first = await create(f); expect((await submitExpense(await actor(f), { id: first.id, expectedVersion: 1, reason: "Dedicated matching requester scope" }, { db })).state).toBe("PENDING_APPROVAL");
    await withTenant(db, f.org, tx => tx.roleAssignment.update({ where: { id: trait.id }, data: { scopeId: randomUUID() } }));
    const second = await create(f, { ...f.input, idempotencyKey: randomUUID() });
    expect((await submitExpense(await actor(f), { id: second.id, expectedVersion: 1, reason: "Dedicated unrelated requester scope" }, { db })).state).toBe("APPROVED");
  });
  it("drives configured actions from native expense events once and binds the canonical financial approval", async () => {
    const f = await fixture(); await policy(f); const reviewer = await approver(f, "property", f.property.id);
    await withTenant(db, f.org, async tx => {
      await new ConfigRuleRepository(tx, f.org).createVersion({ key: "finance.approval_thresholds", scopeType: "property", scopeId: f.property.id,
        effectiveFrom: new Date("2020-01-02"), reason: "Dedicated native automation approval", value: { thresholds: [{ key: "native_threshold", amount: "100", currency: "MAD", requires_approval_from: ["manager"] }],
          routing: { manager: { people: [reviewer.person.id], roles: [], assigned: false, channels: ["in_app"] } } } });
      const role = await tx.role.create({ data: { organizationId: f.org, key: "dedicated_expense_automator", name: "Dedicated expense automation author" } });
      const permissions = await tx.permission.findMany({ where: { key: { in: ["config_rule:view", "config_rule:create", "config_rule:configure", "property:view"] } } }); expect(permissions).toHaveLength(4);
      await tx.rolePermission.createMany({ data: permissions.map(permission => ({ organizationId: f.org, roleId: role.id, permissionId: permission.id })) });
      await tx.roleAssignment.create({ data: { organizationId: f.org, roleId: role.id, userAccountId: f.account.id, personId: f.person.id, scopeType: "property", scopeId: f.property.id, validFrom: new Date("2020-01-01") } });
    });
    const ctx = { ...await actor(f), personId: f.person.id }, sources = [];
    for (const event of ["ExpenseSubmitted", "ExpenseOverThreshold"] as const) sources.push(await saveAutomationRule(ctx, { key: `native_${event.toLowerCase()}`, propertyId: f.property.id,
      lifecycle: "ACTIVE", effectiveFrom: new Date("2020-01-01"), reason: "Dedicated native expense action configuration", rule: {
        name: { en: "Review submitted expense", fr: "Valider la dépense soumise" }, enabled: true, event, conditions: { path: "expense.amount", op: ">", value: "100.00" },
        idempotency_key: "{{expense.id}}", retry: { max_attempts: 2, delay_seconds: 1 }, actions: [{ key: "approval", type: "create_approval_request",
          title: { en: "Review submitted expense", fr: "Valider la dépense soumise" }, details: { en: "Review the configured financial request", fr: "Valider la demande financière configurée" } }] } }, { db }));
    const draft = await create(f), submitted = await submitExpense(ctx, { id: draft.id, expectedVersion: 1, reason: "Dedicated native expense automation submission" }, { db });
    const events = await withTenant(db, f.org, tx => tx.outboxEvent.findMany({ where: { type: { in: ["ExpenseSubmitted","ExpenseOverThreshold"] } } })); expect(events).toHaveLength(2);
    for (const event of events) {
      const ids = await Promise.all([enqueueAutomationEvent(f.org, event.id, { db }), enqueueAutomationEvent(f.org, event.id, { db })]); expect(ids[0]).toEqual(ids[1]); expect(ids[0]).toHaveLength(1);
      expect(await Promise.all([executeAutomationRun(f.org, ids[0][0], { db }), executeAutomationRun(f.org, ids[0][0], { db })])).toEqual(["SUCCEEDED","SUCCEEDED"]);
    }
    await withTenant(db, f.org, async tx => {
      expect(await tx.approvalRequest.count()).toBe(1); expect(await tx.automationRun.count()).toBe(2);
      const runs = await tx.automationRun.findMany();
      for (const run of runs) {
        expect(run.attemptCount).toBe(1); expect(run.status).toBe("SUCCEEDED");
        expect(z.array(z.object({ producedIds: z.array(z.uuid()) })).parse(run.outputs)).toEqual([expect.objectContaining({ producedIds: [submitted.approvalId] })]);
      }
      expect(await tx.financialTransaction.count()).toBe(0);
    });
    await withTenant(db, f.org, tx => tx.roleAssignment.update({ where: { id: f.grant.id }, data: { conditions: { maxAmount: "400" } } }));
    await expect(previewAutomation({ ...await actor(f), personId: f.person.id }, { ruleId: sources[0].id, eventId: events.find(event => event.type === "ExpenseSubmitted")!.id }, { db })).rejects.toThrow("automation_forbidden");
    const other = await fixture();
    await withTenant(db, other.org, async tx => {
      const forged = await tx.outboxEvent.create({ data: { organizationId: other.org, type: "ExpenseSubmitted", idempotencyKey: `expense:${draft.id}:ExpenseSubmitted`,
        payload: { propertyId: other.property.id, expenseId: draft.id } } });
      await expect(new AutomationRepository(tx, other.org).context(forged.id)).rejects.toThrow("automation_source_missing");
    });
  });
  it("retains one winning version and both audit facts when edits compete", async () => {
    const f = await fixture(), row = await create(f), ctx = await actor(f);
    const edits = await Promise.allSettled(["25.00","75.25"].map(amount => updateExpenseDraft(ctx, { id: row.id, expectedVersion: 1, draft: { ...f.input, amount } }, { db })));
    expect(edits.filter(value => value.status === "fulfilled")).toHaveLength(1);
    const rejected = edits.find(value => value.status === "rejected"); expect(rejected?.status).toBe("rejected");
    if (rejected?.status === "rejected") expect(rejected.reason).toBeInstanceOf(ExpenseConflictError);
    await withTenant(db, f.org, async tx => {
      expect(await tx.expense.findFirstOrThrow()).toMatchObject({ version: 2 });
      const edit = await tx.auditLog.findFirstOrThrow({ where: { action: "expense.updated" } });
      expect(edit.before).toMatchObject({ amount: "500.25", version: 1 }); expect(edit.after).toMatchObject({ version: 2 });
    });
  });
  it("denies expired financial grants and foreign property/account references without creating drafts", async () => {
    const f = await fixture(), other = await fixture();
    await expect(create(f, { ...f.input, propertyId: other.property.id })).rejects.toBeInstanceOf(ExpenseAccessError);
    await expect(create(f, { ...f.input, fundingAccountId: other.bank.id })).rejects.toThrow();
    const stale = await actor(f); await withTenant(db, f.org, tx => tx.roleAssignment.update({ where: { id: f.grant.id }, data: { validTo: new Date() } }));
    await expect(createExpenseDraft(stale, f.input, { db })).rejects.toBeInstanceOf(ExpenseAccessError);
    expect(await withTenant(db, f.org, tx => tx.expense.count())).toBe(0);
  });
  it("clears an optional reservation link while preserving its prior value in the audit", async () => {
    const f = await fixture();
    const reservation = await withTenant(db, f.org, tx => tx.reservation.create({ data: { organizationId: f.org, propertyId: f.property.id,
      reference: randomUUID(), source: "DIRECT", guestName: "Dedicated fictional expense guest", checkIn: new Date("2027-04-01"), checkOut: new Date("2027-04-03"), nights: 2, idempotencyKey: randomUUID() } }));
    const row = await createExpenseDraft(await actor(f), { ...f.input, reservationId: reservation.id }, { db });
    await updateExpenseDraft(await actor(f), { id: row.id, expectedVersion: 1, draft: f.input }, { db });
    await withTenant(db, f.org, async tx => {
      expect((await tx.expense.findUniqueOrThrow({ where: { id: row.id } })).reservationId).toBeNull();
      expect((await tx.auditLog.findFirstOrThrow({ where: { action: "expense.updated" } })).before).toMatchObject({ reservationId: reservation.id });
    });
  });
  it("masks historical large amounts when a later smaller draft falls inside the current grant", async () => {
    const f = await fixture(), row = await create(f);
    await updateExpenseDraft(await actor(f), { id: row.id, expectedVersion: 1, draft: { ...f.input, amount: "25" } }, { db });
    await withTenant(db, f.org, tx => tx.roleAssignment.update({ where: { id: f.grant.id }, data: { conditions: { maxAmount: "100" } } }));
    const ctx = { ...await actor(f), personId: f.person.id };
    await withTenant(db, f.org, async tx => {
      const audit = await tx.auditLog.findFirstOrThrow({ where: { action: "expense.updated" } });
      const resource = (await new AuditRepository(tx, f.org).expenseResources([row.id])).get(row.id)!;
      expect(resource.amount).toBe("25"); expect(presentAuditHistoryRow(ctx, audit, "view", resource).before).toBe(maskedValue);
      const created = await tx.auditLog.findFirstOrThrow({ where: { action: "expense.created" } });
      expect(presentAuditHistoryRow(ctx, created, "export", resource).after).toBe(maskedValue);
    });
  });
  it("keeps submitted facts and submission snapshots immutable under tenant RLS", async () => {
    const f = await fixture(), other = await fixture(), row = await create(f);
    await policy(f); await submitExpense(await actor(f), { id: row.id, expectedVersion: 1, reason: "Dedicated native immutable source" }, { db });
    await expect(withTenant(db, f.org, tx => tx.expense.update({ where: { id: row.id }, data: { amount: "1", version: { increment: 1 } } }))).rejects.toThrow("immutable");
    await expect(withTenant(db, f.org, tx => tx.expenseSubmission.updateMany({ data: { snapshot: {} } }))).rejects.toThrow("append-only");
    expect(await withTenant(db, other.org, tx => tx.expense.findMany({ where: { id: row.id } }))).toEqual([]);
    expect(await withTenant(db, f.org, tx => tx.expense.findUniqueOrThrow({ where: { id: row.id } }))).toMatchObject({ state: "APPROVED", version: 3 });
  });
  it("rejects raw submission and state changes without the complete atomic source, event and audit", async () => {
    const f = await fixture(), row = await create(f);
    await expect(withTenant(db, f.org, tx => new ExpenseRepository(tx, f.org).transition(row.id, 1, "DRAFT", "PENDING_APPROVAL", f.account.id))).rejects.toThrow("original financial facts");
    await expect(withTenant(db, f.org, tx => new ExpenseRepository(tx, f.org).submit(row.id, f.account.id, { schemaVersion: 1 }, new Date()))).rejects.toThrow("drafts cannot contain");
    expect(await withTenant(db, f.org, tx => tx.expense.findFirstOrThrow())).toMatchObject({ state: "DRAFT", version: 1 });
  });
  it("resolves agreement scope and versioned condition references through the existing policy consumer", async () => {
    const f = await fixture();
    const source = await withTenant(db, f.org, async tx => {
      const role = await tx.role.create({ data: { organizationId: f.org, key: "expense_policy_configurer", name: "Dedicated policy configuration" } });
      const permissions = await tx.permission.findMany({ where: { organizationId: f.org, key: { in: ["financial_transaction:configure", "financial_transaction:view"] } } });
      expect(permissions).toHaveLength(2);
      await tx.rolePermission.createMany({ data: permissions.map(permission => ({ organizationId: f.org, roleId: role.id, permissionId: permission.id })) });
      await tx.roleAssignment.create({ data: { organizationId: f.org, userAccountId: f.account.id, personId: f.person.id, roleId: role.id,
        scopeType: "organization", validFrom: new Date("2020-01-01") } });
      const agreement = await tx.managementAgreement.create({ data: { organizationId: f.org, propertyId: f.property.id, reference: "Dedicated expense agreement",
        effectiveFrom: new Date("2026-01-01"), status: "ACTIVE" } });
      const rules = new ConfigRuleRepository(tx, f.org);
      await tx.configRule.create({ data: { organizationId: f.org, key: "legacy.unrecognized", scopeType: "property", scopeId: f.property.id,
        effectiveFrom: new Date("2020-01-01"), version: 1, lifecycle: "ACTIVE", reason: "Dedicated preserved legacy metadata", value: { preserved: true } } });
      await rules.createVersion({ key: "finance.expense_allocation", scopeType: "property", scopeId: f.property.id,
        effectiveFrom: new Date("2020-01-01"), reason: "Dedicated property fallback", value: { default_treatment: "OWNER_PAID" } });
      const allocation = await rules.createVersion({ key: "finance.expense_allocation", scopeType: "agreement", scopeId: agreement.id,
        effectiveFrom: new Date("2026-01-01"), reason: "Dedicated effective agreement policy", value: { default_treatment: "ALVILLAS_PAID" } });
      const reference = await rules.createVersion({ key: "finance.payout_schedule", scopeType: "property", scopeId: f.property.id,
        effectiveFrom: new Date("2026-01-01"), reason: "Dedicated referenced configured amount", value: { cadence: "MONTHLY", holdback_amount: "600", holdback_currency: "MAD" } });
      await rules.createVersion({ key: "finance.approval_thresholds", scopeType: "agreement", scopeId: agreement.id,
        effectiveFrom: new Date("2026-01-01"), reason: "Dedicated configured approval condition", value: { thresholds: [{ key: "configured_reference",
          conditions: { path: "expense.amount", op: ">", value: { config: "finance.payout_schedule", path: "holdback_amount" } }, requires_approval_from: ["manager_owner"] }] } });
      return { allocation, reference };
    });
    const input = { propertyId: f.property.id, category: "maintenance", amount: "1000", currency: "MAD", asOf: new Date("2026-10-26T00:00:00Z") };
    const first = await evaluateExpensePolicy(await actor(f), input, { db });
    expect(first.allocationRule.configRuleId).toBe(source.allocation.id); expect(first.allocation.alvillasAmount.toJSON().amount).toBe("1000.00");
    expect(first.approval.requiredSteps).toEqual(["manager_owner"]); expect(first.configReferences[0].configRuleId).toBe(source.reference.id);
    await withTenant(db, f.org, tx => new ConfigRuleRepository(tx, f.org).createVersion({ key: "finance.payout_schedule", scopeType: "property", scopeId: f.property.id,
      effectiveFrom: new Date("2026-10-27"), reason: "Dedicated future policy version", value: { cadence: "MONTHLY", holdback_amount: "1200", holdback_currency: "MAD" } }));
    expect((await evaluateExpensePolicy(await actor(f), input, { db })).configReferences[0].configRuleId).toBe(source.reference.id);
    expect((await evaluateExpensePolicy(await actor(f), { ...input, asOf: new Date("2026-10-28") }, { db })).approval.requiredSteps).toEqual([]);
    expect(first.configReferences[0].version).toBe(1);
    expect(await withTenant(db, f.org, tx => tx.configRule.findFirstOrThrow({ where: { key: "legacy.unrecognized" } }))).toMatchObject({ value: { preserved: true } });
  });
});
