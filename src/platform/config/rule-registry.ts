import { z } from "zod";
import { localizedTextSchema } from "@/i18n/content";

const moneyAmountSchema = z
  .string()
  .trim()
  .regex(/^(?:0|[1-9]\d{0,15})(?:\.\d{1,2})?$/u, "Use a money amount with up to 2 decimals");

const currencySchema = z.string().trim().regex(/^[A-Z]{3}$/u);
const configSlugSchema = z.string().trim().min(1).max(120).regex(/^[a-z0-9_.-]+$/u);

export const taskTypeSchema = z.enum([
  "ARRIVAL_PREPARATION",
  "CHECKOUT_CLEANING",
  "CLEANING_MIDSTAY",
  "INSPECTION",
  "POOL",
  "GARDEN",
  "MAINTENANCE",
  "CUSTOM"
]);

export const taskDueAnchorSchema = z.enum(["CHECK_IN", "CHECK_OUT"]);

export const taskChecklistTemplateSchema = z.object({
  key: configSlugSchema.max(80),
  label: localizedTextSchema
});

export const reservationTaskTemplateSchema = z.object({
  key: configSlugSchema.max(80),
  type: taskTypeSchema,
  title: localizedTextSchema,
  due: taskDueAnchorSchema,
  priority: z.enum(["LOW", "NORMAL", "HIGH", "URGENT"]).default("NORMAL"),
  checklist: z.array(taskChecklistTemplateSchema).max(24).default([])
});

export const reservationTaskConfigSchema = z.object({
  tasks: z.array(reservationTaskTemplateSchema).min(1).max(12)
});

export const commissionConfigKey = "finance.commission";
export const reservationTaskTemplatesConfigKey = "ops.reservation_task_templates";

export const commissionBasisSchema = z.enum([
  "GROSS_ACCOMMODATION",
  "NET_OF_OTA_FEES",
  "TOTAL_INCLUDING_SERVICES",
  "CUSTOM_FORMULA"
]);

export const commissionAccrualEventSchema = z.enum([
  "ON_CONFIRMATION",
  "ON_CHECKIN",
  "ON_CHECKOUT",
  "ON_RECEIPT"
]);

export const commissionRuleValueSchema = z
  .object({
    rate_bps: z.number().int().min(0).max(10000),
    basis: commissionBasisSchema,
    accrual_event: commissionAccrualEventSchema,
    expense_treatments: z.unknown().optional(),
    approval_thresholds: z.unknown().optional(),
    payout_rule: z.unknown().optional()
  })
  .passthrough();

const feeRuleSchema = z
  .object({
    mode: z.enum(["PERCENT_BPS", "FIXED_AMOUNT", "PASS_THROUGH", "CUSTOM_FORMULA"]),
    rate_bps: z.number().int().min(0).max(10000).optional(),
    amount: moneyAmountSchema.optional(),
    currency: currencySchema.optional(),
    basis: z.enum(["GROSS_ACCOMMODATION", "GROSS_WITH_SERVICES", "PAYOUT", "CUSTOM"]).optional()
  })
  .passthrough();

const expenseTreatmentSchema = z
  .object({
    default_treatment: z.enum([
      "OWNER_PAID",
      "ALVILLAS_PAID",
      "INCLUDED_IN_COMMISSION",
      "GUEST_PAID",
      "SHARED",
      "REIMBURSABLE",
      "DEDUCT_FROM_PAYOUT",
      "CUSTOM"
    ]),
    categories: z.record(
      configSlugSchema,
      z
        .object({
          treatment: z.enum([
            "OWNER_PAID",
            "ALVILLAS_PAID",
            "INCLUDED_IN_COMMISSION",
            "GUEST_PAID",
            "SHARED",
            "REIMBURSABLE",
            "DEDUCT_FROM_PAYOUT",
            "CUSTOM"
          ]),
          owner_share_bps: z.number().int().min(0).max(10000).optional(),
          alvillas_share_bps: z.number().int().min(0).max(10000).optional(),
          approval_rule_key: configSlugSchema.optional()
        })
        .passthrough()
    ).optional()
  })
  .passthrough();

const approvalStepSchema = z.enum(["manager", "owner", "manager_owner", "finance", "none"]);

const approvalThresholdsSchema = z
  .object({
    thresholds: z.array(
      z
        .object({
          key: configSlugSchema,
          category: configSlugSchema.optional(),
          amount: moneyAmountSchema.optional(),
          currency: currencySchema.optional(),
          percentage_of_revenue_bps: z.number().int().min(0).max(10000).optional(),
          emergency_bypass_owner: z.boolean().default(false),
          requires_approval_from: z.array(approvalStepSchema).min(1)
        })
        .passthrough()
    )
  })
  .passthrough();

const payoutScheduleSchema = z
  .object({
    cadence: z.enum([
      "AFTER_CHECKOUT",
      "PER_BOOKING",
      "WEEKLY",
      "FIFTEEN_DAY",
      "MONTHLY",
      "CUSTOM_CRON",
      "OTA_SPLIT_EXPECTED_SETTLEMENT"
    ]),
    hold_days: z.number().int().min(0).max(366).optional(),
    holdback_amount: moneyAmountSchema.optional(),
    holdback_currency: currencySchema.optional(),
    holdback_bps: z.number().int().min(0).max(10000).optional(),
    cron: z.string().trim().min(5).max(120).optional(),
    rules: z.array(z.unknown()).optional()
  })
  .passthrough();

const staffCompensationSchema = z
  .object({
    compensation_type: z.enum(["SALARY", "PER_TASK", "HOURLY", "CUSTOM"]),
    rates: z.array(z.unknown()).optional()
  })
  .passthrough();

const laundryPricingSchema = z
  .object({
    prices: z.array(
      z
        .object({
          item: configSlugSchema,
          amount: moneyAmountSchema,
          currency: currencySchema
        })
        .passthrough()
    )
  })
  .passthrough();

const inventoryMinimumsSchema = z
  .object({
    minimums: z.array(
      z
        .object({
          item: configSlugSchema,
          quantity: z.number().int().min(0)
        })
        .passthrough()
    )
  })
  .passthrough();

const workflowConditionSchema: z.ZodType = z.lazy(() =>
  z
    .object({
      all: z.array(workflowConditionSchema).optional(),
      any: z.array(workflowConditionSchema).optional(),
      not: workflowConditionSchema.optional(),
      path: z.string().trim().min(1).max(160).optional(),
      op: z.enum(["=", "!=", ">", ">=", "<", "<=", "in", "not_in", "exists", "between"]).optional(),
      value: z.unknown().optional()
    })
    .refine(
      (value) =>
        Boolean(value.all?.length || value.any?.length || value.not || (value.path && value.op)),
      "Workflow condition needs a combinator or path/operator"
    )
);

const workflowSchema = z
  .object({
    workflows: z.array(
      z
        .object({
          key: configSlugSchema,
          version: z.number().int().min(1).optional(),
          trigger: configSlugSchema,
          conditions: workflowConditionSchema.optional(),
          actions: z.array(
            z
              .object({
                type: configSlugSchema
              })
              .passthrough()
          ).min(1),
          idempotency_key: z.string().trim().min(1).max(180).optional()
        })
        .passthrough()
    )
  })
  .passthrough();

const servicePricingSchema = z
  .object({
    services: z.array(
      z
        .object({
          key: configSlugSchema,
          pricing_model: z.enum(["FIXED", "PER_GUEST", "PER_DAY", "CUSTOM"]),
          amount: moneyAmountSchema.optional(),
          currency: currencySchema.optional()
        })
        .passthrough()
    )
  })
  .passthrough();

const taxRuleSchema = z
  .object({
    taxes: z.array(
      z
        .object({
          key: configSlugSchema,
          rate_bps: z.number().int().min(0).max(10000).optional(),
          amount: moneyAmountSchema.optional(),
          currency: currencySchema.optional()
        })
        .passthrough()
    )
  })
  .passthrough();

const operatingRulesSchema = z
  .object({
    rules: z.record(configSlugSchema, z.unknown())
  })
  .passthrough();

const midStayThresholdSchema = z
  .object({
    nights: z.number().int().min(1),
    task_template_key: configSlugSchema.optional()
  })
  .passthrough();

const featureFlagSchema = z
  .object({
    enabled: z.boolean(),
    variant: configSlugSchema.optional(),
    payload: z.record(configSlugSchema, z.unknown()).optional()
  })
  .passthrough();

export const configRuleSchemas = {
  [commissionConfigKey]: commissionRuleValueSchema,
  "finance.ota_fee": feeRuleSchema,
  "finance.expense_treatment": expenseTreatmentSchema,
  "finance.expense_allocation": expenseTreatmentSchema,
  "finance.approval_thresholds": approvalThresholdsSchema,
  "finance.payout_schedule": payoutScheduleSchema,
  "staff.compensation": staffCompensationSchema,
  "operations.laundry_pricing": laundryPricingSchema,
  "inventory.minimums": inventoryMinimumsSchema,
  "ops.workflows": workflowSchema,
  "services.pricing": servicePricingSchema,
  "finance.tax": taxRuleSchema,
  "ops.operating_rules": operatingRulesSchema,
  "ops.mid_stay_threshold": midStayThresholdSchema,
  [reservationTaskTemplatesConfigKey]: reservationTaskConfigSchema,
  "feature_flag": featureFlagSchema
} as const satisfies Record<string, z.ZodType>;

export type ConfigRuleKey = keyof typeof configRuleSchemas | `feature_flag.${string}`;
export type CommissionRuleValue = z.infer<typeof commissionRuleValueSchema>;

export function schemaForConfigKey(key: string): z.ZodType | null {
  if (key.startsWith("feature_flag.")) {
    return featureFlagSchema;
  }

  return configRuleSchemas[key as keyof typeof configRuleSchemas] ?? null;
}

export function parseConfigRuleValue(key: string, value: unknown): unknown {
  const schema = schemaForConfigKey(key);

  if (!schema) {
    throw new Error(`Unknown config rule key: ${key}`);
  }

  return schema.parse(value);
}
