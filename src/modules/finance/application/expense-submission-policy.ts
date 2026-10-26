import { z } from "zod";
import type { Prisma } from "@prisma/client";
import type { TenantTransaction } from "@/platform/db/tenant";
import { authorize, type Resource } from "@/platform/authz/authorize";
import { referencedConfigs } from "@/platform/automation/rule";
import { approvalThresholdsConfigSchema, type ApprovalThresholdsConfig } from "@/platform/config/rule-registry";
import { NotificationRepository } from "@/platform/notifications/notification-repository";
import { notificationRoutingSchema } from "@/platform/notifications/notification-routing";
import { calendarDateStart } from "@/platform/time/calendar";
import { Money } from "@/platform/money/money";
import { allocateConfiguredExpense, evaluateConfiguredApproval } from "../domain/configured-finance-rules";
import { allocateGrossRevenueByOwnerShare, type PropertyOwnerShare } from "../domain/reservation-revenue";
import { ExpenseRepository, type ExpenseRecord } from "../infrastructure/expense-repository";
import { evaluateExpensePolicyInTransaction, type ExpensePolicyDecision } from "./finance-config-service";
import type { FinanceActorContext } from "./finance-access";

export class ExpensePolicyUnavailableError extends Error {}
const json = (value: unknown) => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonObject;
const ownersSchema = z.array(z.object({ ownerId: z.uuid(), ownerName: z.string(), shareBps: z.number().int().min(0).max(10000) }));
type Stage = { kind: string; ownerId: string | null; amount: string; currency: string; routing: Prisma.InputJsonObject; recipients: string[] };

/** Business windows are configured; boundaries follow the property's IANA calendar. */
export function expenseRevenueWindow(config: ApprovalThresholdsConfig, occurredOn: string, timezone: string, reservationId: string | null) {
  if (!config.revenue_period) throw new ExpensePolicyUnavailableError("Percentage approval requires a configured revenue period");
  const period = config.revenue_period;
  if (period.unit === "RESERVATION") {
    if (!reservationId) throw new ExpensePolicyUnavailableError("Reservation revenue period requires a source reservation");
    return { reservationId };
  }
  const date = new Date(`${z.iso.date().parse(occurredOn)}T00:00:00.000Z`), end = new Date(date), start = new Date(date);
  if (period.unit === "MONTH") { start.setUTCDate(1); end.setUTCMonth(end.getUTCMonth() + 1, 1); }
  else if (period.unit === "YEAR") { start.setUTCMonth(0,1); end.setUTCFullYear(end.getUTCFullYear()+1,0,1); }
  else if (period.unit === "ROLLING_DAYS") { start.setUTCDate(start.getUTCDate() - period.days + 1); end.setUTCDate(end.getUTCDate()+1); }
  else throw new ExpensePolicyUnavailableError("Unknown configured revenue period");
  return { startsAt: calendarDateStart(start.toISOString().slice(0,10), timezone), endsAt: calendarDateStart(end.toISOString().slice(0,10), timezone) };
}

export async function prepareExpenseSubmissionPolicy(ctx: FinanceActorContext, row: ExpenseRecord, target: Resource, tx: TenantTransaction, now: Date) {
  const repository = new ExpenseRepository(tx, ctx.organizationId), source = await repository.sourceOwners(row.propertyId, row.reservationId ?? undefined);
  let owners: PropertyOwnerShare[];
  if (row.reservationId) {
    if (source.snapshot) owners = z.object({ owners: ownersSchema }).parse(source.snapshot.rules).owners;
    else owners = source.commissionSnapshots.map(snapshot => ({ ownerId: snapshot.ownerId, shareBps: snapshot.shareBps,
      ownerName: z.object({ owner_name: z.string() }).parse(snapshot.snapshotValue).owner_name }));
    if (!owners.length) throw new ExpensePolicyUnavailableError("Original reservation ownership snapshot is required");
  } else owners = source.owners;
  if (!owners.length) throw new ExpensePolicyUnavailableError("Expense property ownership is not configured");
  const amount = Money.of(row.amount.toString(), row.currency), slices = allocateGrossRevenueByOwnerShare(amount, owners), policies = [], stages: Stage[] = [];
  let ownerTotal = Money.zero(row.currency), companyTotal = Money.zero(row.currency), guestTotal = Money.zero(row.currency), postHocOwnerNotificationRequired = false, overThreshold = false;
  const notifications = new NotificationRepository(tx, ctx.organizationId);
  for (const slice of slices) {
    let revenueEvidence: Record<string, unknown> | null = null;
    const periodRevenue = async (config: ApprovalThresholdsConfig) => {
      if (!config.thresholds.some(threshold => threshold.percentage_of_revenue_bps !== undefined)) return Money.zero(row.currency);
      const window = expenseRevenueWindow(config, row.occurredOn.toISOString().slice(0,10), row.property.timezone, row.reservationId);
      const value = await repository.periodRevenue({ ...window, propertyId: row.propertyId, currency: row.currency });
      const revenue = Money.of(value, row.currency);
      if (revenue.amount.lt(0)) throw new ExpensePolicyUnavailableError("Configured revenue period has a negative net revenue");
      if (!authorize(ctx.authContext, "view", { ...target, type: "financial_transaction", amount: value }, now)) throw new ExpensePolicyUnavailableError("Revenue policy source is not authorized");
      revenueEvidence = { period: config.revenue_period, ...window, amount: revenue.toJSON() }; return revenue;
    };
    let policy: ExpensePolicyDecision;
    if (row.reservationId) {
      const original = source.commissionSnapshots.find(snapshot => snapshot.ownerId === slice.ownerId);
      if (!original?.configRuleId || original.propertyId !== row.propertyId || original.shareBps !== slice.shareBps) throw new ExpensePolicyUnavailableError("Original owner agreement policy is unavailable");
      const frozen = z.object({ config_rule_version: z.number().int().positive(), expense_treatments: z.unknown(), approval_thresholds: z.unknown() }).parse(original.snapshotValue);
      const approvalConfig = approvalThresholdsConfigSchema.parse(frozen.approval_thresholds);
      // Older snapshots without referenced values cannot safely use today's rules.
      if (referencedConfigs(approvalConfig).length) throw new ExpensePolicyUnavailableError("Original referenced approval configuration is unavailable");
      const allocation = allocateConfiguredExpense(frozen.expense_treatments, { amount: slice.grossAmount, category: row.category });
      const roles = [...new Set((ctx.authContext.assignments ?? []).filter(assignment => assignment.roleKey && authorize({ ...ctx.authContext, assignments: [assignment] }, "edit", target, now)).map(assignment => assignment.roleKey!))];
      const approval = evaluateConfiguredApproval(approvalConfig, { amount, category: row.category, emergency: row.emergency,
        ruleKey: allocation.approvalRuleKey ?? undefined, periodRevenue: await periodRevenue(approvalConfig),
        evaluation: { fields: { expense: { id: row.id, propertyId: row.propertyId, reservationId: row.reservationId, ownerId: slice.ownerId,
          amount: amount.amount.toString(), allocatedAmount: slice.grossAmount.amount.toString(), currency: row.currency, category: row.category, emergency: row.emergency },
          actor: { userAccountId: ctx.actorId, roles } }, configs: {} } });
      const evidence = { configRuleId: original.configRuleId, version: frozen.config_rule_version, scopeType: "reservation_snapshot", scopeId: row.reservationId };
      policy = { allocation, approval, allocationRule: { ...evidence, key: "finance.expense_treatment", snapshotValue: { value: frozen.expense_treatments, commissionSnapshotId: original.id } },
        approvalRule: { ...evidence, key: "finance.approval_thresholds", snapshotValue: { value: approvalConfig, commissionSnapshotId: original.id } }, configReferences: [] };
    } else {
      policy = await evaluateExpensePolicyInTransaction(ctx, { propertyId: row.propertyId, ownerId: slice.ownerId, amount: slice.grossAmount.amount.toString(), currency: row.currency,
        category: row.category, emergency: row.emergency, asOf: calendarDateStart(row.occurredOn.toISOString().slice(0,10), row.property.timezone) }, tx,
        { resource: target, approvalAmount: amount, resolvePeriodRevenue: periodRevenue, now });
      if (!policy.approvalRule) throw new ExpensePolicyUnavailableError("Explicit approval policy is required");
    }
    ownerTotal = ownerTotal.add(policy.allocation.ownerAmount); companyTotal = companyTotal.add(policy.allocation.alvillasAmount); guestTotal = guestTotal.add(policy.allocation.guestAmount);
    const configured = approvalThresholdsConfigSchema.parse(policy.approvalRule!.snapshotValue.value);
    const matched = configured.thresholds.find(threshold => threshold.key === policy.approval.matchedThresholdKey);
    overThreshold ||= Boolean(matched && (matched.amount !== undefined || matched.percentage_of_revenue_bps !== undefined));
    const requiredSteps = policy.approval.requiredSteps.flatMap(step => step === "manager_owner" ? ["manager", "owner"] : [step]);
    for (const kind of requiredSteps) {
      const routing = notificationRoutingSchema.parse(configured.routing?.[kind as "manager" | "owner" | "finance"]);
      await notifications.validateRoutingReferences(routing, row.propertyId);
      const recipients = await notifications.approvers(routing, { ...target, ownerId: slice.ownerId, status: "PENDING_APPROVAL" });
      if (!recipients.length) throw new ExpensePolicyUnavailableError("Configured financial approval has no authorized recipient");
      stages.push({ kind, ownerId: slice.ownerId, amount: amount.amount.toString(), currency: row.currency, routing: json(routing), recipients });
    }
    postHocOwnerNotificationRequired ||= policy.approval.postHocOwnerNotificationRequired;
    policies.push({ ownerId: slice.ownerId, ownerName: slice.ownerName, shareBps: slice.shareBps, sourceAmount: slice.grossAmount.toJSON(),
      allocation: { treatment: policy.allocation.treatment, owner: policy.allocation.ownerAmount.toJSON(), alvillas: policy.allocation.alvillasAmount.toJSON(), guest: policy.allocation.guestAmount.toJSON() },
      approval: policy.approval, allocationRule: policy.allocationRule, approvalRule: policy.approvalRule, configReferences: policy.configReferences, revenueEvidence });
  }
  if (!ownerTotal.add(companyTotal).add(guestTotal).amount.eq(amount.amount)) throw new ExpensePolicyUnavailableError("Owner expense policies do not conserve the invoice total");
  return { stages, overThreshold, snapshot: json({ schemaVersion: 1, sourceExpenseVersion: row.version, propertyId: row.propertyId, reservationId: row.reservationId,
    occurredOn: row.occurredOn.toISOString().slice(0,10), timezone: row.property.timezone, amount: amount.toJSON(), category: row.category, purpose: row.purpose,
    fundingAccountId: row.fundingAccountId, emergency: row.emergency, ownershipSnapshotId: source.snapshot?.id ?? null, policies,
    allocation: { owner: ownerTotal.toJSON(), alvillas: companyTotal.toJSON(), guest: guestTotal.toJSON() }, stages, postHocOwnerNotificationRequired }) };
}
