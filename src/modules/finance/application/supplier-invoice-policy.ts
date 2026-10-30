import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/platform/db/client";
import { withTenant, type TenantTransaction, type TenantTransactionRunner } from "@/platform/db/tenant";
import { authorize, type AuthContext, type Resource } from "@/platform/authz/authorize";
import { authorizeOrganizationSource } from "@/platform/authz/organization-authority";
import { Money } from "@/platform/money/money";
import { calendarDateStart } from "@/platform/time/calendar";
import { approvalThresholdsConfigSchema } from "@/platform/config/rule-registry";
import { ConfigRuleRepository } from "@/platform/config/config-rule-repository";
import { notificationRoutingSchema } from "@/platform/notifications/notification-routing";
import { NotificationRepository } from "@/platform/notifications/notification-repository";
import { CompanyLedgerRepository } from "../infrastructure/company-ledger-repository";
import { FinanceRepository } from "../infrastructure/finance-repository";
import { SupplierInvoiceRepository, type SupplierInvoiceRecord } from "../infrastructure/supplier-invoice-repository";
import { supplierInvoiceCostResource } from "../domain/supplier-invoice";
import { assertSupplierInvoiceAuthority, SupplierInvoiceAccessError } from "./supplier-invoice-access";
import { evaluateCompanyCostPolicyInTransaction, financePolicyRoleKeys, FinancePolicyContextChangedError } from "./finance-config-service";
import { ExpensePolicyUnavailableError, expenseRevenueWindow, preparePropertyCostSubmissionPolicy, type FinancialPolicyStage } from "./expense-submission-policy";
import type { FinanceActorContext } from "./finance-access";

export const supplierInvoicePolicyInput = z.object({ id: z.uuid().transform(value => value.toLowerCase()), expectedVersion: z.number().int().nonnegative(),
  occurredOn: z.iso.date(), emergency: z.boolean() }).strict();
type PolicyInput = z.infer<typeof supplierInvoicePolicyInput>;
type Line = NonNullable<SupplierInvoiceRecord["currentRevision"]>["lines"][number];
type Stage = FinancialPolicyStage & { lineId: string; propertyId: string | null; reservationId: string | null };
type CompanyConfiguration = { asOf: Date; snapshot: Awaited<ReturnType<ConfigRuleRepository["scopedSnapshot"]>>;
  revenue: Map<string, { window: ReturnType<typeof expenseRevenueWindow>; amount: Money }> };
const json = (value: unknown) => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonObject;

async function companyLinePolicy(ctx: FinanceActorContext, row: SupplierInvoiceRecord, line: Line, input: PolicyInput, target: Resource,
  timezone: string, authorities: readonly AuthContext[], tx: TenantTransaction, now: Date, configuration: CompanyConfiguration) {
  const amount = Money.of(line.amount.toString(), line.currency), companyLedger = new CompanyLedgerRepository(tx, ctx.organizationId);
  let revenueEvidence: Prisma.InputJsonObject | null = null;
  const policy = await evaluateCompanyCostPolicyInTransaction(ctx, { amount: amount.toJSON().amount, currency: line.currency, category: line.category,
    emergency: input.emergency, asOf: configuration.asOf }, tx, { resource: target, now, authorities, configuration: configuration.snapshot,
    approvalAmount: Money.of(row.currentRevision!.amount.toString(), line.currency), resolvePeriodRevenue: async config => {
      if (!config.thresholds.some(threshold => threshold.percentage_of_revenue_bps !== undefined)) return Money.zero(line.currency);
      if (config.revenue_source?.basis !== "COMPANY_ACCOUNTS") throw new ExpensePolicyUnavailableError("Company percentage approval requires explicit company revenue accounts");
      if (authorities.some(authority => !authorizeOrganizationSource(authority, "view", { type: "company_ledger", organizationId: ctx.organizationId, dataClass: "financial" }, now)))
        throw new SupplierInvoiceAccessError();
      const key = JSON.stringify({ occurredOn: input.occurredOn, timezone, currency: line.currency, period: config.revenue_period, source: config.revenue_source });
      let observed = configuration.revenue.get(key);
      if (!observed) {
        const window = expenseRevenueWindow(config, input.occurredOn, timezone, null);
        const amount = Money.of(await companyLedger.revenue({ ...window, currency: line.currency, accountCodes: config.revenue_source.account_codes }), line.currency);
        if (amount.amount.lt(0)) throw new ExpensePolicyUnavailableError("Company approval revenue cannot be negative");
        observed = { window, amount }; configuration.revenue.set(key, observed);
      }
      const { window, amount: revenue } = observed;
      revenueEvidence = json({ period: config.revenue_period, source: config.revenue_source, ...window, amount: revenue.toJSON() });
      return revenue;
    } });
  if (!policy.approvalRule || !policy.allocation.ownerAmount.amount.isZero() || !policy.allocation.guestAmount.amount.isZero())
    throw new ExpensePolicyUnavailableError("Company invoice lines require an explicit company allocation and approval policy");
  const configured = approvalThresholdsConfigSchema.parse(policy.approvalRule.snapshotValue.value), stages: FinancialPolicyStage[] = [];
  if (policy.approval.postHocOwnerNotificationRequired || policy.approval.requiredSteps.some(kind => kind === "owner" || kind === "manager_owner"))
    throw new ExpensePolicyUnavailableError("Company invoice lines cannot invent an owner approval source");
  const notifications = new NotificationRepository(tx, ctx.organizationId);
  for (const kind of policy.approval.requiredSteps) {
    const routing = notificationRoutingSchema.parse(configured.routing?.[kind as "manager" | "finance"]);
    await notifications.validateRoutingReferences(routing, null);
    const recipients = await notifications.approvers(routing, { ...target, status: "PENDING_APPROVAL" });
    if (!recipients.length) throw new ExpensePolicyUnavailableError("Configured invoice approval has no authorized recipient");
    stages.push({ kind, ownerId: null, amount: amount.toJSON().amount, currency: line.currency, routing: json(routing), recipients });
  }
  return { stages, postHocNotices: [], requiresCompanyRevenue: Boolean(revenueEvidence), snapshot: json({ schemaVersion: 1, sourceKind: "supplier_invoice_line", invoiceId: row.id,
    revisionId: row.currentRevisionId, lineId: line.id, propertyId: null, reservationId: null, occurredOn: input.occurredOn, timezone,
    amount: amount.toJSON(), category: line.category, purpose: row.currentRevision!.purpose, emergency: input.emergency, actorRoles: financePolicyRoleKeys(ctx, target, now, authorities),
    allocation: { owner: policy.allocation.ownerAmount.toJSON(), alvillas: policy.allocation.alvillasAmount.toJSON(), guest: policy.allocation.guestAmount.toJSON() },
    policies: [{ organizationId: ctx.organizationId, allocationRule: policy.allocationRule, approvalRule: policy.approvalRule,
      configReferences: policy.configReferences, approval: policy.approval, revenueEvidence }], stages }) };
}

/** Uses actual invoice-line identities; preparing policy creates no expense or journal. */
export async function prepareSupplierInvoicePolicy(ctx: FinanceActorContext, row: SupplierInvoiceRecord, input: PolicyInput, tx: TenantTransaction, now: Date) {
  const current = await assertSupplierInvoiceAuthority(ctx, tx, "edit", now), revision = row.currentRevision;
  if (row.organizationId !== ctx.organizationId || row.id !== input.id || row.version !== input.expectedVersion || row.state !== "DRAFT" || row.archivedAt || row.supplier.archivedAt || !revision)
    throw new SupplierInvoiceAccessError();
  const authorities = [ctx.authContext, current], invoiceAmount = Money.of(revision.amount.toString(), revision.currency), stages: Stage[] = [], lines = [], postHocNotices = [];
  const checks: Array<{ resource: Resource; organizationOnly: boolean }> = [];
  const roleChecks: Array<{ resource: Resource; roles: string[] }> = [];
  const requireSource = (resource: Resource, organizationOnly = false) => {
    checks.push({ resource, organizationOnly });
    if (authorities.some(authority => organizationOnly ? !authorizeOrganizationSource(authority, "view", resource, now) : !authorize(authority, "view", resource, now))) throw new SupplierInvoiceAccessError();
  };
  const companyTimezone = revision.lines.some(line => !line.propertyId) ? (await new CompanyLedgerRepository(tx, ctx.organizationId).settings()).timezone : null;
  const instants = new Map<string, Date>();
  let companyConfiguration: CompanyConfiguration | undefined;
  for (const line of revision.lines) {
    const timezone = line.propertyId ? line.property?.timezone : companyTimezone;
    if (!timezone || line.property?.archivedAt || (line.propertyId && !line.property)) throw new ExpensePolicyUnavailableError("Invoice cost calendar and active property source are required");
    let instant = instants.get(timezone);
    if (!instant) { instant = calendarDateStart(input.occurredOn, timezone); instants.set(timezone, instant); }
    const target = supplierInvoiceCostResource(ctx.organizationId, row, line, Money.of(line.amount.toString(), line.currency), input.occurredOn, timezone, instant);
    const actorRoles = financePolicyRoleKeys(ctx, target, now, authorities); roleChecks.push({ resource: target, roles: actorRoles });
    const source = { ...target, type: "financial_transaction", id: undefined, financialRecordId: undefined };
    requireSource(source, !line.propertyId);
    if (line.reservationId) requireSource({ ...target, id: line.reservationId, financialRecordId: undefined,
      type: "reservation", status: line.reservation?.status, assignedUserAccountId: line.reservation?.createdBy ?? undefined });
    if (!line.propertyId && !companyConfiguration) companyConfiguration = { asOf: instant,
      snapshot: await new ConfigRuleRepository(tx, ctx.organizationId).scopedSnapshot([{ scopeType: "organization", scopeId: null }], instant), revenue: new Map() };
    const plan = line.propertyId ? await preparePropertyCostSubmissionPolicy(ctx, { id: line.id, propertyId: line.propertyId, reservationId: line.reservationId,
      amount: line.amount, currency: line.currency, category: line.category, occurredOn: new Date(input.occurredOn + "T00:00:00.000Z"), emergency: input.emergency,
      purpose: revision.purpose, property: { timezone } }, target, tx, now,
      { sourceKind: "supplier_invoice_line", invoiceId: row.id, revisionId: revision.id, lineId: line.id, actorRoles },
      { approvalAmount: invoiceAmount, discloseOwnerSlice: true, authorities }) : await companyLinePolicy(ctx, row, line, input, target, timezone, authorities, tx, now, companyConfiguration!);
    if ("requiresCompanyRevenue" in plan && plan.requiresCompanyRevenue) requireSource({ type: "company_ledger", organizationId: ctx.organizationId, dataClass: "financial" }, true);
    const revenues = z.object({ policies: z.array(z.object({ revenueEvidence: z.object({ amount: z.object({ amount: z.string() }) }).nullable().optional() })) }).parse(plan.snapshot);
    if (line.propertyId) for (const policy of revenues.policies) if (policy.revenueEvidence) requireSource({ ...source, amount: policy.revenueEvidence.amount.amount });
    stages.push(...plan.stages.map(stage => ({ ...stage, lineId: line.id, propertyId: line.propertyId, reservationId: line.reservationId })));
    postHocNotices.push(...plan.postHocNotices.map(notice => ({ ...notice, lineId: line.id, propertyId: line.propertyId })));
    lines.push({ id: line.id, position: line.position, propertyId: line.propertyId, reservationId: line.reservationId, amount: Money.of(line.amount.toString(), line.currency).toJSON(),
      category: line.category, costCenter: line.costCenter, policy: plan.snapshot });
  }
  const recheckAuthorization = async () => {
    const related = revision.lines.filter(line => line.propertyId || line.reservationId);
    if (related.length) {
      const repository = new SupplierInvoiceRepository(tx, ctx.organizationId), actual = await repository.recognitionSource(row.id, related.map(line => line.id));
      if (!actual || actual.archivedAt || actual.supplier.archivedAt || actual.currentRevision?.id !== revision.id || actual.currentRevision.lines.length !== related.length) throw new SupplierInvoiceAccessError();
      const currentLines = new Map(actual.currentRevision.lines.map(line => [line.id, line]));
      const reservationIds = related.flatMap(line => line.reservationId ? [line.reservationId] : []);
      const reservations = new Map((reservationIds.length ? await repository.reservations(reservationIds) : []).map(reservation => [reservation.id, reservation]));
      for (const captured of related) {
        const current = currentLines.get(captured.id);
        if (!current || current.propertyId !== captured.propertyId || current.reservationId !== captured.reservationId ||
          current.propertyId && (!current.property || current.property.archivedAt || current.property.cityId !== captured.property?.cityId ||
            current.property.regionId !== captured.property?.regionId || current.property.timezone !== captured.property?.timezone)) throw new SupplierInvoiceAccessError();
        if (captured.reservationId) {
          const reservation = reservations.get(captured.reservationId);
          if (!reservation || reservation.propertyId !== captured.propertyId || reservation.status !== captured.reservation?.status || reservation.createdBy !== captured.reservation?.createdBy) throw new SupplierInvoiceAccessError();
        }
      }
    }
    const at = await new FinanceRepository(tx, ctx.organizationId).clock(), renewed = await assertSupplierInvoiceAuthority(ctx, tx, "edit", at);
    for (const { resource, organizationOnly } of checks) if ([ctx.authContext, renewed].some(authority => organizationOnly ?
      !authorizeOrganizationSource(authority, "view", resource, at) : !authorize(authority, "view", resource, at))) throw new SupplierInvoiceAccessError();
    for (const { resource, roles } of roleChecks) if (JSON.stringify(financePolicyRoleKeys(ctx, resource, at, [ctx.authContext, renewed])) !== JSON.stringify(roles))
      throw new FinancePolicyContextChangedError("Financial policy actor roles changed during preparation");
  };
  await recheckAuthorization();
  return { stages, postHocNotices, snapshot: json({ schemaVersion: 1, invoiceId: row.id, sourceInvoiceVersion: row.version, revisionId: revision.id,
    supplierId: row.supplierId, amount: invoiceAmount.toJSON(), occurredOn: input.occurredOn, emergency: input.emergency, lines, stages, postHocNotices }), recheckAuthorization };
}

export async function getSupplierInvoicePolicyPreview(ctx: FinanceActorContext, raw: unknown, deps: { db?: TenantTransactionRunner } = {}) {
  const input = supplierInvoicePolicyInput.parse(raw);
  return withTenant(deps.db ?? prisma, ctx.organizationId, async tx => {
    const repository = new SupplierInvoiceRepository(tx, ctx.organizationId), finance = new FinanceRepository(tx, ctx.organizationId);
    await repository.lock(input.id); const row = await repository.find(input.id), now = await finance.clock();
    if (!row) throw new SupplierInvoiceAccessError();
    const plan = await prepareSupplierInvoicePolicy(ctx, row, input, tx, now);
    const at = await finance.clock(); await assertSupplierInvoiceAuthority(ctx, tx, "edit", at);
    return { stages: plan.stages, postHocNotices: plan.postHocNotices, snapshot: plan.snapshot };
  }, { timeout: 120000 });
}

export async function getSupplierInvoiceSubmissionPreview(ctx: FinanceActorContext, raw: unknown, deps: { db?: TenantTransactionRunner } = {}) {
  const plan = await getSupplierInvoicePolicyPreview(ctx, raw, deps);
  const snapshot = z.object({ lines: z.array(z.object({ id: z.uuid(), policy: z.object({ allocation: z.object({
    owner: z.object({ amount: z.string(), currency: z.string() }), alvillas: z.object({ amount: z.string(), currency: z.string() }),
    guest: z.object({ amount: z.string(), currency: z.string() }) }) }) })) }).parse(plan.snapshot);
  return { requiredStages: plan.stages.length, emergencyNotices: plan.postHocNotices.length,
    lines: snapshot.lines.map(line => ({ id: line.id, ...line.policy.allocation })) };
}
