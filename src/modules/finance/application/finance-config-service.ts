import { z } from "zod";
import {
  ConfigRuleRepository,
  configRuleSnapshotMetadata,
  type ConfigScopeCandidate,
  type ResolvedConfigRule
} from "@/platform/config/config-rule-repository";
import { authorize, roleKeysForResource, type AuthContext, type Resource } from "@/platform/authz/authorize";
import { approvalThresholdsConfigSchema, payoutCalendarSchema, type ApprovalThresholdsConfig } from "@/platform/config/rule-registry";
import { prisma } from "@/platform/db/client";
import { withTenant, type TenantTransaction, type TenantTransactionRunner } from "@/platform/db/tenant";
import { Money } from "@/platform/money/money";
import { referencedConfigs } from "@/platform/automation/rule";
import { ReservationConfigScopeRepository } from "@/platform/config/reservation-scope-repository";
import {
  allocateConfiguredExpense,
  evaluateConfiguredApproval,
  planConfiguredPayout,
  type ConfiguredApprovalDecision,
  type ConfiguredExpenseAllocation,
  type ConfiguredPayoutPlan
} from "@/modules/finance/domain/configured-finance-rules";

export class FinanceConfigAuthorizationError extends Error {
  constructor(message = "Finance configuration action is not authorized") {
    super(message);
    this.name = "FinanceConfigAuthorizationError";
  }
}

export class FinanceConfigNotFoundError extends Error {
  constructor(message = "Finance configuration rule was not found") {
    super(message);
    this.name = "FinanceConfigNotFoundError";
  }
}
export class FinancePolicyContextChangedError extends Error {}

/** Arbitrary rule conditions are not monotonic: a missing role can add or waive review. */
export function financePolicyRoleKeys(ctx: FinanceConfigActorContext, resource: Resource, now: Date, authorities: readonly AuthContext[] = []) {
  const roles = roleKeysForResource(ctx.authContext, resource, now), signature = JSON.stringify([...roles].sort());
  if (authorities.some(authority => JSON.stringify(roleKeysForResource(authority, resource, now).sort()) !== signature))
    throw new FinancePolicyContextChangedError("Financial policy actor roles changed; reload the authorization context");
  return roles;
}

type FinanceConfigActorContext = {
  organizationId: string;
  actorId: string;
  authContext: AuthContext;
};

type FinanceConfigServiceDeps = {
  db?: TenantTransactionRunner;
};

export type ConfigDecisionEvidence = {
  configRuleId: string;
  key: string;
  version: number;
  scopeType: string;
  scopeId: string | null;
  snapshotValue: Record<string, unknown>;
};

export type ExpensePolicyDecision = {
  allocation: ConfiguredExpenseAllocation;
  approval: ConfiguredApprovalDecision;
  allocationRule: ConfigDecisionEvidence;
  approvalRule: ConfigDecisionEvidence | null;
  configReferences: ConfigDecisionEvidence[];
};

export type OwnerPayoutPlanDecision = {
  payout: ConfiguredPayoutPlan;
  payoutRule: ConfigDecisionEvidence;
};

const moneyAmountSchema = z
  .string()
  .trim()
  .regex(/^(?:0|[1-9]\d{0,15})(?:\.\d{1,2})?$/u, "Use a money amount with up to 2 decimals");
const currencySchema = z.string().trim().regex(/^[A-Z]{3}$/u);

export const expensePolicyInputSchema = z.object({
  propertyId: z.string().uuid(),
  ownerId: z.string().uuid().optional(),
  category: z.string().trim().min(1).max(120),
  amount: moneyAmountSchema,
  currency: currencySchema,
  periodRevenueAmount: moneyAmountSchema.optional(),
  emergency: z.boolean().default(false),
  asOf: z.coerce.date().optional()
});

export const ownerPayoutPlanInputSchema = z.object({
  propertyId: z.string().uuid(),
  ownerId: z.string().uuid().optional(),
  availableBalance: z.string().trim().max(80).regex(/^-?(?:0|[1-9]\d*)(?:\.\d{1,2})?$/u),
  currency: currencySchema,
  checkoutDate: z.coerce.date().optional(),
  completedAt: z.coerce.date().optional(),
  settlementAt: z.coerce.date().optional(),
  timezone: payoutCalendarSchema.shape.timezone,
  triggeredAt: z.coerce.date(),
  asOf: z.coerce.date().optional()
});

export type ExpensePolicyInput = z.input<typeof expensePolicyInputSchema>;
export type OwnerPayoutPlanInput = z.input<typeof ownerPayoutPlanInputSchema>;

function db(deps: FinanceConfigServiceDeps): TenantTransactionRunner {
  return deps.db ?? prisma;
}

function assertAllowed(ctx: FinanceConfigActorContext): void {
  const allowed = authorize(ctx.authContext, "view", {
    type: "financial_transaction",
    organizationId: ctx.organizationId,
    dataClass: "financial"
  });

  if (!allowed) {
    throw new FinanceConfigAuthorizationError();
  }
}

function evidence(rule: ResolvedConfigRule): ConfigDecisionEvidence {
  return {
    configRuleId: rule.id,
    key: rule.key,
    version: rule.version,
    scopeType: rule.scopeType,
    scopeId: rule.scopeId,
    snapshotValue: {
      ...configRuleSnapshotMetadata(rule),
      value: rule.parsedValue
    }
  };
}

async function resolveRequired(
  repository: ConfigRuleRepository,
  key: string,
  scopes: readonly ConfigScopeCandidate[],
  asOf: Date
): Promise<ResolvedConfigRule> {
  const rule = await repository.resolve({ key, scopes, asOf });

  if (!rule) {
    throw new FinanceConfigNotFoundError(`Missing finance configuration rule: ${key}`);
  }

  return rule;
}

export async function evaluateExpensePolicy(
  ctx: FinanceConfigActorContext,
  rawInput: ExpensePolicyInput,
  deps: FinanceConfigServiceDeps = {}
): Promise<ExpensePolicyDecision> {
  assertAllowed(ctx);
  return withTenant(db(deps), ctx.organizationId, tx => evaluateExpensePolicyInTransaction(ctx, rawInput, tx));
}

/** Caller authorizes the actual expense before resolving its financial policy. */
type ExpensePolicyOptions = { resource?: Resource; approvalAmount?: Money; resolvePeriodRevenue?: (config: ApprovalThresholdsConfig) => Promise<Money>; now?: Date; authorities?: readonly AuthContext[];
  configuration?: Awaited<ReturnType<ConfigRuleRepository["scopedSnapshot"]>> };
export async function evaluateExpensePolicyInTransaction(ctx: FinanceConfigActorContext, rawInput: ExpensePolicyInput, tx: TenantTransaction,
  options: ExpensePolicyOptions = {}): Promise<ExpensePolicyDecision> {
  const parsed = expensePolicyInputSchema.parse(rawInput), input = { ...parsed, asOf: parsed.asOf ?? new Date() };
  const scopes = await new ReservationConfigScopeRepository(tx, ctx.organizationId).scopes(input);
  return evaluateCostPolicy(ctx, input, tx, scopes, options);
}

/** An organization cost has no invented property, owner or physical funding account. */
const companyCostPolicyInputSchema = expensePolicyInputSchema.omit({ propertyId: true, ownerId: true, periodRevenueAmount: true })
  .extend({ asOf: z.coerce.date() }).strict();
export async function evaluateCompanyCostPolicyInTransaction(ctx: FinanceConfigActorContext, rawInput: z.input<typeof companyCostPolicyInputSchema>, tx: TenantTransaction,
  options: ExpensePolicyOptions & { resource: Resource; now: Date }): Promise<ExpensePolicyDecision> {
  return evaluateCostPolicy(ctx, companyCostPolicyInputSchema.parse(rawInput), tx, [{ scopeType: "organization", scopeId: null }], options);
}

async function evaluateCostPolicy(ctx: FinanceConfigActorContext, input: Omit<z.output<typeof expensePolicyInputSchema>, "propertyId"> & { propertyId?: string },
  tx: TenantTransaction, scopes: readonly ConfigScopeCandidate[], options: ExpensePolicyOptions): Promise<ExpensePolicyDecision> {
  const amount = Money.of(input.amount, input.currency);
  let periodRevenue = input.periodRevenueAmount
    ? Money.of(input.periodRevenueAmount, input.currency)
    : undefined;
  const asOf = input.asOf ?? new Date();

    const repository = new ConfigRuleRepository(tx, ctx.organizationId);
    const snapshot = options.configuration ?? await repository.scopedSnapshot(scopes, asOf);
    if (options.configuration && !snapshot.appliesTo(tx, ctx.organizationId, scopes, asOf)) throw new FinancePolicyContextChangedError("Financial configuration snapshot belongs to another transaction, organization, scope or instant");
    const allocationRule = snapshot.resolve("finance.expense_allocation") ?? snapshot.resolve("finance.expense_treatment");

    if (!allocationRule) {
      throw new FinanceConfigNotFoundError("Missing finance expense allocation rule");
    }

    const approvalRule = snapshot.resolve("finance.approval_thresholds");
    if (approvalRule && options.resolvePeriodRevenue) periodRevenue = await options.resolvePeriodRevenue(approvalThresholdsConfigSchema.parse(approvalRule.value));
    const references = approvalRule ? referencedConfigs(approvalRule.value).map(key => {
      const rule = snapshot.resolve(key); if (!rule) throw new FinanceConfigNotFoundError(`Missing referenced finance configuration: ${key}`); return rule;
    }) : [];
    const subject = options.resource ?? { type: "expense", organizationId: ctx.organizationId, propertyId: input.propertyId, ownerId: input.ownerId, amount: input.amount, dataClass: "financial" as const };
    const roles = financePolicyRoleKeys(ctx, subject, options.now ?? new Date(), options.authorities);
    const allocation = allocateConfiguredExpense(allocationRule.value, { category: input.category, amount });
    const evaluation = { fields: { expense: { propertyId: input.propertyId, ownerId: input.ownerId ?? null, category: input.category,
      amount: (options.approvalAmount ?? amount).amount.toString(), allocatedAmount: amount.amount.toString(), currency: input.currency, emergency: input.emergency }, actor: { userAccountId: ctx.actorId, roles } },
      configs: Object.fromEntries(references.map(rule => [rule.key, rule.parsedValue])) };

    return {
      allocation,
      approval: approvalRule
        ? evaluateConfiguredApproval(approvalRule.value, {
            category: input.category,
            amount: options.approvalAmount ?? amount,
            ruleKey: allocation.approvalRuleKey ?? undefined,
            periodRevenue,
            emergency: input.emergency,
            evaluation
          })
        : {
            matchedThresholdKey: null,
            requiredSteps: [],
            postHocOwnerNotificationRequired: false
          },
      allocationRule: evidence(allocationRule),
      approvalRule: approvalRule ? evidence(approvalRule) : null,
      configReferences: references.map(evidence)
    };
}

export async function planOwnerPayout(
  ctx: FinanceConfigActorContext,
  rawInput: OwnerPayoutPlanInput,
  deps: FinanceConfigServiceDeps = {}
): Promise<OwnerPayoutPlanDecision> {
  assertAllowed(ctx);
  const input = ownerPayoutPlanInputSchema.parse(rawInput);
  const asOf = input.asOf ?? input.triggeredAt;

  return withTenant(db(deps), ctx.organizationId, async (tx) => {
    const repository = new ConfigRuleRepository(tx, ctx.organizationId);
    const scopes = await new ReservationConfigScopeRepository(tx, ctx.organizationId).scopes({
      propertyId: input.propertyId, ownerId: input.ownerId, asOf
    });
    const payoutRule = await resolveRequired(
      repository,
      "finance.payout_schedule",
      scopes,
      asOf
    );

    return {
      payout: planConfiguredPayout(payoutRule.value, {
        availableBalance: Money.of(input.availableBalance, input.currency),
        checkoutDate: input.checkoutDate,
        completedAt: input.completedAt,
        settlementAt: input.settlementAt,
        triggeredAt: input.triggeredAt,
        timezone: input.timezone,
        hashSeed: [ctx.organizationId, input.propertyId, input.ownerId, payoutRule.id].join(":")
      }),
      payoutRule: evidence(payoutRule)
    };
  });
}
