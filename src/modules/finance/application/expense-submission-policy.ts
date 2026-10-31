import { z } from "zod";
import type { Prisma } from "@prisma/client";
import type { TenantTransaction } from "@/platform/db/tenant";
import { authorize, type AuthContext, type Resource } from "@/platform/authz/authorize";
import { referencedConfigs } from "@/platform/automation/rule";
import { approvalThresholdsConfigSchema, type ApprovalThresholdsConfig } from "@/platform/config/rule-registry";
import { NotificationRepository } from "@/platform/notifications/notification-repository";
import { notificationRoutingSchema } from "@/platform/notifications/notification-routing";
import { calendarDateStart } from "@/platform/time/calendar";
import { Money } from "@/platform/money/money";
import { allocateConfiguredExpense, evaluateConfiguredApproval } from "../domain/configured-finance-rules";
import { allocateGrossRevenueByOwnerShare, type PropertyOwnerShare } from "../domain/reservation-revenue";
import { ExpenseRepository, type ExpenseRecord } from "../infrastructure/expense-repository";
import { evaluateExpensePolicyInTransaction, financePolicyRoleKeys, type ExpensePolicyDecision, type ConfigDecisionEvidence } from "./finance-config-service";
import type { FinanceActorContext } from "./finance-access";
import type { ExpenseEmergencyNotice } from "../domain/expense";

export class ExpensePolicyUnavailableError extends Error {}
const json = (value: unknown) => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonObject;
const ownersSchema = z.array(z.object({ ownerId: z.uuid(), ownerName: z.string(), shareBps: z.number().int().min(0).max(10000) }));
const storedRuleSchema = z.object({ config_rule_id: z.uuid(), key: z.string(), config_rule_version: z.number().int().positive(),
  config_rule_scope_type: z.string(), config_rule_scope_id: z.string().nullable(), value: z.unknown() }).passthrough();
const decisionEvidenceSchema = z.object({ configRuleId: z.uuid(), key: z.string(), version: z.number().int().positive(),
  scopeType: z.string(), scopeId: z.string().nullable(), snapshotValue: z.record(z.string(), z.unknown()) });
const correctionPolicySchema = z.object({ timezone: z.string().min(1), ownershipSnapshotId: z.uuid().nullable(),
  policies: z.array(ownersSchema.element.extend({ allocationRule: decisionEvidenceSchema, approvalRule: decisionEvidenceSchema,
    configReferences: z.array(decisionEvidenceSchema) })).min(1) });
function frozenEvidence(rule: z.infer<typeof storedRuleSchema>): ConfigDecisionEvidence {
  return { configRuleId: rule.config_rule_id, key: rule.key, version: rule.config_rule_version, scopeType: rule.config_rule_scope_type,
    scopeId: rule.config_rule_scope_id, snapshotValue: rule };
}
export type FinancialPolicyStage = { kind: string; ownerId: string | null; amount: string; currency: string; routing: Prisma.InputJsonObject; recipients: string[] };
export type PropertyCostPolicySource = Pick<ExpenseRecord, "id" | "propertyId" | "reservationId" | "amount" | "currency" | "category" | "occurredOn" | "emergency" | "purpose"> & {
  property: Pick<ExpenseRecord["property"], "timezone">;
  correctsExpenseId?: ExpenseRecord["correctsExpenseId"];
  correctsExpense?: ExpenseRecord["correctsExpense"];
};

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
  return preparePropertyCostSubmissionPolicy(ctx, row, target, tx, now, { sourceExpenseVersion: row.version, fundingAccountId: row.fundingAccountId });
}

/** One property-cost engine serves paid expenses and actual unpaid invoice lines. */
export async function preparePropertyCostSubmissionPolicy(ctx: FinanceActorContext, row: PropertyCostPolicySource, target: Resource,
  tx: TenantTransaction, now: Date, sourceEvidence: Prisma.InputJsonObject,
  options: { approvalAmount?: Money; discloseOwnerSlice?: boolean; authorities?: readonly AuthContext[];postHocAudience?:(notice:ExpenseEmergencyNotice,resource:Resource)=>void } = {}) {
  const repository = new ExpenseRepository(tx, ctx.organizationId), source = await repository.sourceOwners(row.propertyId, row.reservationId ?? undefined);
  const correction = row.correctsExpenseId ? correctionPolicySchema.safeParse(row.correctsExpense?.submission?.snapshot) : null;
  if (correction && !correction.success) throw new ExpensePolicyUnavailableError("Original expense agreement policy is unavailable");
  const prior = correction?.success ? correction.data : null, timezone = prior?.timezone ?? row.property.timezone;
  const frame = z.object({ rules: z.array(z.object({ id: z.uuid(), key: z.string(), version: z.number().int().positive(), scopeType: z.string(), scopeId: z.string().nullable(), value: z.unknown() })) }).safeParse(source.snapshot?.rules);
  const frameRules = frame.success ? frame.data.rules.map(rule => frozenEvidence({ config_rule_id: rule.id, key: rule.key, config_rule_version: rule.version,
    config_rule_scope_type: rule.scopeType, config_rule_scope_id: rule.scopeId, value: rule.value })) : [];
  let owners: PropertyOwnerShare[];
  if (prior) owners = prior.policies;
  else if (row.reservationId) {
    if (source.snapshot) owners = z.object({ owners: ownersSchema }).parse(source.snapshot.rules).owners;
    else owners = source.commissionSnapshots.map(snapshot => ({ ownerId: snapshot.ownerId, shareBps: snapshot.shareBps,
      ownerName: z.object({ owner_name: z.string() }).parse(snapshot.snapshotValue).owner_name }));
    if (!owners.length) throw new ExpensePolicyUnavailableError("Original reservation ownership snapshot is required");
  } else owners = source.owners;
  if (!owners.length) throw new ExpensePolicyUnavailableError("Expense property ownership is not configured");
  const amount = Money.of(row.amount.toString(), row.currency), approvalAmount = options.approvalAmount ?? amount;
  if (approvalAmount.currency !== amount.currency || approvalAmount.amount.lt(amount.amount)) throw new ExpensePolicyUnavailableError("Approval source must cover its exact cost in the same currency");
  const slices = allocateGrossRevenueByOwnerShare(amount, owners), policies = [], stages: FinancialPolicyStage[] = [];
  const postHocNotices: ExpenseEmergencyNotice[] = [];
  let ownerTotal = Money.zero(row.currency), companyTotal = Money.zero(row.currency), guestTotal = Money.zero(row.currency), postHocOwnerNotificationRequired = false, overThreshold = false;
  const notifications = new NotificationRepository(tx, ctx.organizationId);
  for (const slice of slices) {
    let revenueEvidence: Record<string, unknown> | null = null;
    const periodRevenue = async (config: ApprovalThresholdsConfig) => {
      if (!config.thresholds.some(threshold => threshold.percentage_of_revenue_bps !== undefined)) return Money.zero(row.currency);
      if (config.revenue_source && config.revenue_source.basis !== "OWNER_GROSS") throw new ExpensePolicyUnavailableError("Property approval requires its owner revenue source");
      const window = expenseRevenueWindow(config, row.occurredOn.toISOString().slice(0,10), timezone, row.reservationId);
      const revenueSource = options.authorities ? { ...target, id: undefined, financialRecordId: undefined, reservationId: row.reservationId, type: "financial_transaction" } : { ...target, type: "financial_transaction" };
      if (options.authorities?.some(authority => !authorize(authority, "view", revenueSource, now))) throw new ExpensePolicyUnavailableError("Revenue policy source is not authorized");
      const value = await repository.periodRevenue({ ...window, propertyId: row.propertyId, currency: row.currency });
      const revenue = Money.of(value, row.currency);
      if (revenue.amount.lt(0)) throw new ExpensePolicyUnavailableError("Configured revenue period has a negative net revenue");
      if ((options.authorities ?? [ctx.authContext]).some(authority => !authorize(authority, "view", { ...revenueSource, amount: value }, now))) throw new ExpensePolicyUnavailableError("Revenue policy source is not authorized");
      revenueEvidence = { period: config.revenue_period, ...window, amount: revenue.toJSON() }; return revenue;
    };
    const fromEvidence = async (allocationRule: ConfigDecisionEvidence, approvalRule: ConfigDecisionEvidence, references: ConfigDecisionEvidence[]): Promise<ExpensePolicyDecision> => {
      const approvalConfig = approvalThresholdsConfigSchema.parse(approvalRule.snapshotValue.value);
      const allocation = allocateConfiguredExpense(allocationRule.snapshotValue.value, { amount: slice.grossAmount, category: row.category });
      const roles = financePolicyRoleKeys(ctx, target, now, options.authorities);
      const approval = evaluateConfiguredApproval(approvalConfig, { amount: approvalAmount, category: row.category, emergency: row.emergency,
        ruleKey: allocation.approvalRuleKey ?? undefined, periodRevenue: await periodRevenue(approvalConfig),
        evaluation: { fields: { expense: { id: row.id, propertyId: row.propertyId, reservationId: row.reservationId, ownerId: slice.ownerId,
          amount: approvalAmount.amount.toString(), allocatedAmount: slice.grossAmount.amount.toString(), currency: row.currency, category: row.category, emergency: row.emergency },
          actor: { userAccountId: ctx.actorId, roles } }, configs: Object.fromEntries(references.map(rule => [rule.key, rule.snapshotValue.value])) } });
      return { allocation, approval, allocationRule, approvalRule, configReferences: references };
    };
    let policy: ExpensePolicyDecision;
    if (prior) {
      const original = prior.policies.find(policy => policy.ownerId === slice.ownerId);
      if (!original) throw new ExpensePolicyUnavailableError("Original expense ownership is unavailable");
      policy = await fromEvidence(original.allocationRule, original.approvalRule, original.configReferences);
    } else if (row.reservationId) {
      const original = source.commissionSnapshots.find(snapshot => snapshot.ownerId === slice.ownerId);
      if (!original?.configRuleId || original.propertyId !== row.propertyId || original.shareBps !== slice.shareBps) throw new ExpensePolicyUnavailableError("Original owner agreement policy is unavailable");
      const frozen = z.object({ config_rule_version: z.number().int().positive(), expense_treatments: z.unknown().optional(), approval_thresholds: z.unknown().optional(),
        expense_policy_rules: z.object({ allocation: storedRuleSchema.nullable(), approval: storedRuleSchema.nullable(), references: z.array(storedRuleSchema), missingReferences: z.array(z.string()) }).optional() }).parse(original.snapshotValue);
      const inline = (key: string, value: unknown): ConfigDecisionEvidence => ({ configRuleId: original.configRuleId!, key, version: frozen.config_rule_version,
        scopeType: "reservation_snapshot", scopeId: row.reservationId, snapshotValue: { value, commissionSnapshotId: original.id } });
      const allocationRule = frozen.expense_treatments !== undefined ? inline("finance.expense_treatment", frozen.expense_treatments) : frozen.expense_policy_rules?.allocation ?
        frozenEvidence(frozen.expense_policy_rules.allocation) : frameRules.find(rule => rule.key === "finance.expense_allocation") ?? frameRules.find(rule => rule.key === "finance.expense_treatment");
      const approvalRule = frozen.approval_thresholds !== undefined ? inline("finance.approval_thresholds", frozen.approval_thresholds) : frozen.expense_policy_rules?.approval ?
        frozenEvidence(frozen.expense_policy_rules.approval) : frameRules.find(rule => rule.key === "finance.approval_thresholds");
      if (!allocationRule || !approvalRule) throw new ExpensePolicyUnavailableError("Original booking expense policy is unavailable");
      const approvalConfig = approvalThresholdsConfigSchema.parse(approvalRule.snapshotValue.value);
      const references = referencedConfigs(approvalConfig).map(key => {
        const rule = frozen.expense_policy_rules?.references.find(rule => rule.key === key);
        const evidence = rule ? frozenEvidence(rule) : frameRules.find(rule => rule.key === key);
        if (!evidence) throw new ExpensePolicyUnavailableError("Original referenced approval configuration is unavailable"); return evidence;
      });
      policy = await fromEvidence(allocationRule, approvalRule, references);
    } else {
      policy = await evaluateExpensePolicyInTransaction(ctx, { propertyId: row.propertyId, ownerId: slice.ownerId, amount: slice.grossAmount.amount.toString(), currency: row.currency,
        category: row.category, emergency: row.emergency, asOf: calendarDateStart(row.occurredOn.toISOString().slice(0,10), timezone) }, tx,
        { resource: target, approvalAmount, resolvePeriodRevenue: periodRevenue, now, authorities: options.authorities });
      if (!policy.approvalRule) throw new ExpensePolicyUnavailableError("Explicit approval policy is required");
    }
    ownerTotal = ownerTotal.add(policy.allocation.ownerAmount); companyTotal = companyTotal.add(policy.allocation.alvillasAmount); guestTotal = guestTotal.add(policy.allocation.guestAmount);
    const configured = approvalThresholdsConfigSchema.parse(policy.approvalRule!.snapshotValue.value);
    const matched = configured.thresholds.find(threshold => threshold.key === policy.approval.matchedThresholdKey);
    overThreshold ||= Boolean(matched && (matched.amount !== undefined || matched.percentage_of_revenue_bps !== undefined));
    const requiredSteps = policy.approval.requiredSteps.flatMap(step => step === "manager_owner" ? ["manager", "owner"] : [step]);
    const stageAmount = options.discloseOwnerSlice ? slice.grossAmount : amount;
    const stageTarget = { ...target, ownerId: slice.ownerId, amount: stageAmount.amount.toString(), status: "PENDING_APPROVAL" };
    for (const kind of requiredSteps) {
      const routing = notificationRoutingSchema.parse(configured.routing?.[kind as "manager" | "owner" | "finance"]);
      await notifications.validateRoutingReferences(routing, row.propertyId);
      const recipients = await notifications.approvers(routing, stageTarget);
      if (!recipients.length) throw new ExpensePolicyUnavailableError("Configured financial approval has no authorized recipient");
      stages.push({ kind, ownerId: slice.ownerId, amount: stageAmount.amount.toString(), currency: row.currency, routing: json(routing), recipients });
    }
    postHocOwnerNotificationRequired ||= policy.approval.postHocOwnerNotificationRequired;
    if (policy.approval.postHocOwnerNotificationRequired) {
      const routing=notificationRoutingSchema.parse(configured.routing?.owner);
      await notifications.validateRoutingReferences(routing,row.propertyId);
      if (!routing.channels.includes("in_app")) throw new ExpensePolicyUnavailableError("Emergency approval requires a durable owner inbox notice");
      const recipients=options.postHocAudience?[]:await notifications.viewers(routing,stageTarget);
      if (!recipients.length&&!options.postHocAudience) throw new ExpensePolicyUnavailableError("Emergency approval has no authorized owner notice recipient");
      const notice={ownerId:slice.ownerId,routing,recipients};postHocNotices.push(notice);options.postHocAudience?.(notice,stageTarget);
    }
    policies.push({ ownerId: slice.ownerId, ownerName: slice.ownerName, shareBps: slice.shareBps, sourceAmount: slice.grossAmount.toJSON(),
      allocation: { treatment: policy.allocation.treatment, owner: policy.allocation.ownerAmount.toJSON(), alvillas: policy.allocation.alvillasAmount.toJSON(), guest: policy.allocation.guestAmount.toJSON() },
      approval: policy.approval, allocationRule: policy.allocationRule, approvalRule: policy.approvalRule, configReferences: policy.configReferences, revenueEvidence });
  }
  if (!ownerTotal.add(companyTotal).add(guestTotal).amount.eq(amount.amount)) throw new ExpensePolicyUnavailableError("Owner expense policies do not conserve the invoice total");
  return { stages, overThreshold,postHocNotices, snapshot: json({ schemaVersion: 1, ...sourceEvidence, propertyId: row.propertyId, reservationId: row.reservationId,
    occurredOn: row.occurredOn.toISOString().slice(0,10), timezone, amount: amount.toJSON(), category: row.category, purpose: row.purpose,
    emergency: row.emergency, ownershipSnapshotId: prior ? prior.ownershipSnapshotId : source.snapshot?.id ?? null, policies,
    ...(prior ? { correctsExpenseId: row.correctsExpenseId, originalSubmissionId: row.correctsExpense?.submission?.id } : {}),
    allocation: { owner: ownerTotal.toJSON(), alvillas: companyTotal.toJSON(), guest: guestTotal.toJSON() }, stages,postHocNotices, postHocOwnerNotificationRequired }) };
}
