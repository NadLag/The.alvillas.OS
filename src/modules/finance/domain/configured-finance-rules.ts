import Decimal from "decimal.js";
import {
  approvalThresholdsConfigSchema,
  expenseTreatmentConfigSchema,
  payoutScheduleConfigSchema,
  type ApprovalThresholdsConfig,
  type ExpenseTreatmentConfig,
  type PayoutScheduleConfig
} from "@/platform/config/rule-registry";
import { Money } from "@/platform/money/money";
import { evaluate, type EvaluationContext } from "@/platform/automation/rule";

type ApprovalThreshold = ApprovalThresholdsConfig["thresholds"][number];
type ExpenseCategoryRule = NonNullable<ExpenseTreatmentConfig["categories"]>[string];

export type ApprovalSubject = {
  category: string;
  amount: Money;
  periodRevenue?: Money;
  emergency?: boolean;
  evaluation?: EvaluationContext;
};

export type ConfiguredApprovalDecision = {
  matchedThresholdKey: string | null;
  requiredSteps: string[];
  postHocOwnerNotificationRequired: boolean;
};

export type ExpensePolicySubject = {
  category: string;
  amount: Money;
};

export type ConfiguredExpenseAllocation = {
  treatment: string;
  approvalRuleKey: string | null;
  ownerShareBps: number;
  alvillasShareBps: number;
  guestShareBps: number;
  ownerAmount: Money;
  alvillasAmount: Money;
  guestAmount: Money;
};

export type PayoutScheduleSubject = {
  availableBalance: Money;
  checkoutDate?: Date;
  triggeredAt: Date;
};

export type ConfiguredPayoutPlan = {
  cadence: PayoutScheduleConfig["cadence"];
  eligibleOn: Date;
  holdbackAmount: Money;
  payableAmount: Money;
  cron: string | null;
};

function uniqueSteps(steps: readonly string[]): string[] {
  return [...new Set(steps.filter((step) => step !== "none"))];
}

function thresholdMatches(threshold: ApprovalThreshold, subject: ApprovalSubject): boolean {
  if (threshold.category && threshold.category !== subject.category) {
    return false;
  }
  if (threshold.conditions && !evaluate(threshold.conditions, subject.evaluation ?? {
    fields: { expense: { category: subject.category, amount: subject.amount.amount.toString(), currency: subject.amount.currency, emergency: subject.emergency ?? false } }, configs: {}
  })) return false;

  let hasCondition = false;
  let matched = false;

  if (threshold.amount) {
    hasCondition = true;
    if (threshold.currency === subject.amount.currency) {
      matched = matched || subject.amount.amount.gte(new Decimal(threshold.amount));
    }
  }

  if (threshold.percentage_of_revenue_bps !== undefined && subject.periodRevenue) {
    hasCondition = true;
    if (subject.periodRevenue.currency === subject.amount.currency) {
      const limit = subject.periodRevenue.amount.mul(threshold.percentage_of_revenue_bps).div(10000);
      matched = matched || subject.amount.amount.gte(limit);
    }
  }

  return hasCondition ? matched : true;
}

function stepsAfterEmergencyBypass(
  steps: readonly string[],
  emergencyBypassOwner: boolean
): { requiredSteps: string[]; postHocOwnerNotificationRequired: boolean } {
  if (!emergencyBypassOwner) {
    return {
      requiredSteps: uniqueSteps(steps),
      postHocOwnerNotificationRequired: false
    };
  }

  const requiredSteps = steps.flatMap((step) => {
    if (step === "owner") {
      return [];
    }

    if (step === "manager_owner") {
      return ["manager"];
    }

    return [step];
  });

  return {
    requiredSteps: uniqueSteps(requiredSteps),
    postHocOwnerNotificationRequired: steps.includes("owner") || steps.includes("manager_owner")
  };
}

export function evaluateConfiguredApproval(
  value: unknown,
  subject: ApprovalSubject
): ConfiguredApprovalDecision {
  const config = approvalThresholdsConfigSchema.parse(value);
  const threshold = config.thresholds.find((candidate) => thresholdMatches(candidate, subject));

  if (!threshold) {
    return {
      matchedThresholdKey: null,
      requiredSteps: [],
      postHocOwnerNotificationRequired: false
    };
  }

  const emergencyBypassOwner = Boolean(subject.emergency && threshold.emergency_bypass_owner);
  const steps = stepsAfterEmergencyBypass(threshold.requires_approval_from, emergencyBypassOwner);

  return {
    matchedThresholdKey: threshold.key,
    ...steps
  };
}

function sharesForTreatment(rule: ExpenseCategoryRule | null, treatment: string): {
  ownerShareBps: number;
  alvillasShareBps: number;
  guestShareBps: number;
} {
  if (treatment === "SHARED") {
    const ownerShareBps = rule?.owner_share_bps;
    const alvillasShareBps = rule?.alvillas_share_bps;

    if (
      typeof ownerShareBps !== "number" ||
      typeof alvillasShareBps !== "number" ||
      !Number.isInteger(ownerShareBps) ||
      !Number.isInteger(alvillasShareBps) ||
      ownerShareBps + alvillasShareBps !== 10000
    ) {
      throw new Error("Shared expense treatment must configure owner and ALVILLAS shares totaling 10000 bps");
    }

    return {
      ownerShareBps,
      alvillasShareBps,
      guestShareBps: 0
    };
  }

  if (
    treatment === "OWNER_PAID" ||
    treatment === "REIMBURSABLE" ||
    treatment === "DEDUCT_FROM_PAYOUT"
  ) {
    return { ownerShareBps: 10000, alvillasShareBps: 0, guestShareBps: 0 };
  }

  if (treatment === "ALVILLAS_PAID" || treatment === "INCLUDED_IN_COMMISSION") {
    return { ownerShareBps: 0, alvillasShareBps: 10000, guestShareBps: 0 };
  }

  if (treatment === "GUEST_PAID") {
    return { ownerShareBps: 0, alvillasShareBps: 0, guestShareBps: 10000 };
  }

  throw new Error(`Expense treatment requires a dedicated workflow: ${treatment}`);
}

function shareAmount(amount: Money, bps: number): Money {
  return amount.multiply(new Decimal(bps).div(10000));
}

export function allocateConfiguredExpense(
  value: unknown,
  subject: ExpensePolicySubject
): ConfiguredExpenseAllocation {
  const config = expenseTreatmentConfigSchema.parse(value);
  const categoryRule = config.categories?.[subject.category] ?? null;
  const treatment = categoryRule?.treatment ?? config.default_treatment;
  const shares = sharesForTreatment(categoryRule, treatment);
  const ownerAmount = shareAmount(subject.amount, shares.ownerShareBps);
  // Assign the final participating share the remainder so rounding cannot
  // create or lose a cent. The configured percentages remain unchanged.
  const alvillasAmount = shares.alvillasShareBps > 0 && shares.guestShareBps === 0
    ? subject.amount.subtract(ownerAmount)
    : shareAmount(subject.amount, shares.alvillasShareBps);
  const guestAmount =
    shares.guestShareBps === 0
      ? Money.zero(subject.amount.currency)
      : subject.amount.subtract(ownerAmount).subtract(alvillasAmount);

  return {
    treatment,
    approvalRuleKey: categoryRule?.approval_rule_key ?? null,
    ...shares,
    ownerAmount,
    alvillasAmount,
    guestAmount
  };
}

function addDays(date: Date, days: number): Date {
  const output = new Date(date.getTime());
  output.setUTCDate(output.getUTCDate() + days);
  return output;
}

function holdbackAmount(config: PayoutScheduleConfig, balance: Money): Money {
  const byAmount =
    config.holdback_amount && config.holdback_currency === balance.currency
      ? Money.of(config.holdback_amount, balance.currency)
      : Money.zero(balance.currency);
  const byRate =
    config.holdback_bps === undefined
      ? Money.zero(balance.currency)
      : balance.multiply(new Decimal(config.holdback_bps).div(10000));

  return byAmount.add(byRate);
}

export function planConfiguredPayout(
  value: unknown,
  subject: PayoutScheduleSubject
): ConfiguredPayoutPlan {
  const config = payoutScheduleConfigSchema.parse(value);
  const baseDate = config.cadence === "AFTER_CHECKOUT" ? subject.checkoutDate ?? subject.triggeredAt : subject.triggeredAt;
  const holdback = holdbackAmount(config, subject.availableBalance);
  const payableAmount = holdback.amount.gte(subject.availableBalance.amount)
    ? Money.zero(subject.availableBalance.currency)
    : subject.availableBalance.subtract(holdback);

  return {
    cadence: config.cadence,
    eligibleOn: addDays(baseDate, config.hold_days ?? 0),
    holdbackAmount: holdback,
    payableAmount,
    cron: config.cron ?? null
  };
}
