import { z } from "zod";
import {
  ConfigRuleRepository,
  configRuleSnapshotMetadata,
  type ConfigScopeCandidate,
  type ResolvedConfigRule
} from "@/platform/config/config-rule-repository";
import { authorize, type AuthContext } from "@/platform/authz/authorize";
import { prisma } from "@/platform/db/client";
import { withTenant, type TenantTransactionRunner } from "@/platform/db/tenant";
import { Money } from "@/platform/money/money";
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
  availableBalance: moneyAmountSchema,
  currency: currencySchema,
  checkoutDate: z.coerce.date().optional(),
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

function scopesFor(input: { propertyId: string; ownerId?: string }): ConfigScopeCandidate[] {
  return [
    { scopeType: "property", scopeId: input.propertyId },
    ...(input.ownerId ? [{ scopeType: "owner", scopeId: input.ownerId }] : []),
    { scopeType: "organization", scopeId: null }
  ];
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
  const input = expensePolicyInputSchema.parse(rawInput);
  const amount = Money.of(input.amount, input.currency);
  const periodRevenue = input.periodRevenueAmount
    ? Money.of(input.periodRevenueAmount, input.currency)
    : undefined;
  const asOf = input.asOf ?? new Date();

  return withTenant(db(deps), ctx.organizationId, async (tx) => {
    const repository = new ConfigRuleRepository(tx, ctx.organizationId);
    const scopes = scopesFor(input);
    const allocationRule =
      (await repository.resolve({
        key: "finance.expense_allocation",
        scopes,
        asOf
      })) ??
      (await repository.resolve({
        key: "finance.expense_treatment",
        scopes,
        asOf
      }));

    if (!allocationRule) {
      throw new FinanceConfigNotFoundError("Missing finance expense allocation rule");
    }

    const approvalRule = await repository.resolve({
      key: "finance.approval_thresholds",
      scopes,
      asOf
    });

    return {
      allocation: allocateConfiguredExpense(allocationRule.value, {
        category: input.category,
        amount
      }),
      approval: approvalRule
        ? evaluateConfiguredApproval(approvalRule.value, {
            category: input.category,
            amount,
            periodRevenue,
            emergency: input.emergency
          })
        : {
            matchedThresholdKey: null,
            requiredSteps: [],
            postHocOwnerNotificationRequired: false
          },
      allocationRule: evidence(allocationRule),
      approvalRule: approvalRule ? evidence(approvalRule) : null
    };
  });
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
    const payoutRule = await resolveRequired(
      repository,
      "finance.payout_schedule",
      scopesFor(input),
      asOf
    );

    return {
      payout: planConfiguredPayout(payoutRule.value, {
        availableBalance: Money.of(input.availableBalance, input.currency),
        checkoutDate: input.checkoutDate,
        triggeredAt: input.triggeredAt
      }),
      payoutRule: evidence(payoutRule)
    };
  });
}
