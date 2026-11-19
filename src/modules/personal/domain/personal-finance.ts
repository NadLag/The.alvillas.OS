import { z } from "zod";
import { normalizeAmountInput } from "@/platform/money/amount-input";
import { Money } from "@/platform/money/money";
import type { HouseholdArea } from "./household-access";

export const financeKinds = ["INCOME", "EXPENSE", "BUDGET", "SAVINGS_GOAL", "SAVINGS_MOVEMENT", "INVESTMENT", "ASSET", "LIABILITY"] as const;
export const financeKindSchema = z.enum(financeKinds);
export type FinanceKind = z.infer<typeof financeKindSchema>;

export const financeAreas = {
  INCOME: "income", EXPENSE: "expenses", BUDGET: "budgets", SAVINGS_GOAL: "savings",
  SAVINGS_MOVEMENT: "savings", INVESTMENT: "investments", ASSET: "positions", LIABILITY: "positions"
} as const satisfies Record<FinanceKind, HouseholdArea>;

export function isMovement(kind: FinanceKind) {
  return kind === "INCOME" || kind === "EXPENSE" || kind === "SAVINGS_MOVEMENT";
}

const supportedCurrencies = new Set(Intl.supportedValuesOf("currency"));
export const personalCurrencySchema = z.string().trim().toUpperCase().refine((value) => supportedCurrencies.has(value));
export const personalAmountSchema = z.string().trim().max(32).transform(normalizeAmountInput)
  .pipe(z.string().regex(/^\d{1,16}(?:\.\d{1,2})?$/u));

export const financeEntrySchema = z.object({
  id: z.uuid(),
  kind: financeKindSchema,
  label: z.string().trim().min(1).max(120),
  category: z.string().trim().min(1).max(80),
  amount: personalAmountSchema,
  currency: personalCurrencySchema,
  effectiveOn: z.iso.date(),
  seriesId: z.uuid().optional(),
  goalId: z.uuid().optional(),
  withdrawal: z.boolean().default(false),
  closed: z.boolean().default(false)
}).strict().superRefine((value, ctx) => {
  if ((value.kind === "SAVINGS_MOVEMENT") !== Boolean(value.goalId)
    || value.withdrawal && value.kind !== "SAVINGS_MOVEMENT"
    || isMovement(value.kind) && (value.seriesId || value.closed)
    || value.closed && !value.seriesId
    || (isMovement(value.kind) || value.kind === "BUDGET" || value.kind === "SAVINGS_GOAL")
      && Money.of(value.amount, value.currency).amount.isZero()) {
    ctx.addIssue({ code: "custom", message: "invalid" });
  }
});

export const reverseEntrySchema = z.object({
  id: z.uuid(), sourceId: z.uuid(), reason: z.string().trim().min(1).max(240)
}).strict();

export function monthStart(day: string) {
  return `${day.slice(0, 7)}-01`;
}

export function dayValue(day: string) {
  return new Date(`${day}T00:00:00.000Z`);
}

export function signedMoney(entry: {
  amount: string;
  currency: string;
  reversesId: string | null;
  withdrawal: boolean;
}) {
  const money = Money.of(entry.amount, entry.currency);
  return Boolean(entry.reversesId) !== entry.withdrawal ? Money.zero(entry.currency).subtract(money) : money;
}
