import type { Prisma } from "@prisma/client";
import type { TenantTransaction } from "@/platform/db/tenant";
import type { AuthContext,Resource } from "@/platform/authz/authorize";
import { authorizeOrganizationSource } from "@/platform/authz/organization-authority";
import { Money } from "@/platform/money/money";
import { approvalThresholdsConfigSchema } from "@/platform/config/rule-registry";
import type { ConfigRuleRepository } from "@/platform/config/config-rule-repository";
import { notificationRoutingSchema } from "@/platform/notifications/notification-routing";
import { NotificationRepository } from "@/platform/notifications/notification-repository";
import { CompanyLedgerRepository } from "../infrastructure/company-ledger-repository";
import { evaluateCompanyCostPolicyInTransaction,financePolicyRoleKeys } from "./finance-config-service";
import { ExpensePolicyUnavailableError,expenseRevenueWindow,type FinancialPolicyStage } from "./expense-submission-policy";
import type { FinanceActorContext } from "./finance-access";
export type CompanyCostConfiguration={asOf:Date;snapshot:Awaited<ReturnType<ConfigRuleRepository["scopedSnapshot"]>>;revenue:Map<string,{window:ReturnType<typeof expenseRevenueWindow>;amount:Money}>};
const json=(value:unknown)=>JSON.parse(JSON.stringify(value)) as Prisma.InputJsonObject;
/** Company costs share allocation, whole-source approval, current revenue authority and actual recipients. */
export async function prepareCompanyCostSubmissionPolicy(ctx:FinanceActorContext,input:{amount:Money;approvalAmount:Money;category:string;purpose:string;occurredOn:string;emergency:boolean;sourceEvidence:Prisma.InputJsonObject},target:Resource,timezone:string,authorities:readonly AuthContext[],tx:TenantTransaction,now:Date,configuration:CompanyCostConfiguration,accessError:()=>Error){
  const amount = input.amount, companyLedger = new CompanyLedgerRepository(tx, ctx.organizationId);
  let revenueEvidence: Prisma.InputJsonObject | null = null;
  const policy = await evaluateCompanyCostPolicyInTransaction(ctx, { amount: amount.toJSON().amount, currency: amount.currency, category: input.category,
    emergency: input.emergency, asOf: configuration.asOf }, tx, { resource: target, now, authorities, configuration: configuration.snapshot,
    approvalAmount: input.approvalAmount, resolvePeriodRevenue: async config => {
      if (!config.thresholds.some(threshold => threshold.percentage_of_revenue_bps !== undefined)) return Money.zero(amount.currency);
      if (config.revenue_source?.basis !== "COMPANY_ACCOUNTS") throw new ExpensePolicyUnavailableError("Company percentage approval requires explicit company revenue accounts");
      if (authorities.some(authority => !authorizeOrganizationSource(authority, "view", { type: "company_ledger", organizationId: ctx.organizationId, dataClass: "financial" }, now)))
        throw accessError();
      const key = JSON.stringify({ occurredOn: input.occurredOn, timezone, currency: amount.currency, period: config.revenue_period, source: config.revenue_source });
      let observed = configuration.revenue.get(key);
      if (!observed) {
        const window = expenseRevenueWindow(config, input.occurredOn, timezone, null);
        const revenueAmount = Money.of(await companyLedger.revenue({ ...window, currency: amount.currency, accountCodes: config.revenue_source.account_codes }), amount.currency);
        if (revenueAmount.amount.lt(0)) throw new ExpensePolicyUnavailableError("Company approval revenue cannot be negative");
        observed = { window, amount:revenueAmount }; configuration.revenue.set(key, observed);
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
    stages.push({ kind, ownerId: null, amount: amount.toJSON().amount, currency: amount.currency, routing: json(routing), recipients });
  }
  return { stages, postHocNotices: [], requiresCompanyRevenue: Boolean(revenueEvidence), snapshot: json({ schemaVersion: 1, ...input.sourceEvidence, propertyId: null, reservationId: null, occurredOn: input.occurredOn, timezone,
    amount: amount.toJSON(), category: input.category, purpose: input.purpose, emergency: input.emergency, actorRoles: financePolicyRoleKeys(ctx, target, now, authorities),
    allocation: { owner: policy.allocation.ownerAmount.toJSON(), alvillas: policy.allocation.alvillasAmount.toJSON(), guest: policy.allocation.guestAmount.toJSON() },
    policies: [{ organizationId: ctx.organizationId, allocationRule: policy.allocationRule, approvalRule: policy.approvalRule,
      configReferences: policy.configReferences, approval: policy.approval, revenueEvidence }], stages }) };
}
