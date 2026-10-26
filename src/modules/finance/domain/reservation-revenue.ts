import Decimal from "decimal.js";
import { z } from "zod";
import {
  commissionAccrualEventSchema,
  commissionBasisSchema,
  commissionConfigKey,
  commissionRuleValueSchema,
  type CommissionRuleValue
} from "@/platform/config/rule-registry";
import type { LedgerSide } from "@/platform/ledger/ledger";
import { assertBalancedPostings } from "@/platform/ledger/ledger";
import { Money } from "@/platform/money/money";

export {
  commissionAccrualEventSchema,
  commissionBasisSchema,
  commissionConfigKey,
  commissionRuleValueSchema
};

const positiveMoneyAmountSchema = z
  .string()
  .trim()
  .regex(/^(?:0|[1-9]\d{0,15})(?:\.\d{1,2})?$/u, "Use a money amount with up to 2 decimals")
  .refine((value) => new Decimal(value).gt(0), "Amount must be greater than zero");

const currencySchema = z.string().trim().regex(/^[A-Z]{3}$/u);

export const recordReservationRevenueInputSchema = z.object({
  reservationId: z.string().uuid(),
  amount: positiveMoneyAmountSchema,
  currency: currencySchema,
  receivedAccountId: z.string().uuid(),
  idempotencyKey: z.string().uuid()
});

export const reverseReservationRevenueInputSchema = z.object({
  reservationId: z.string().uuid(),
  reason: z.string().trim().min(1).max(1000),
  idempotencyKey: z.string().uuid()
});

export type { CommissionRuleValue };
export type RecordReservationRevenueInput = z.infer<typeof recordReservationRevenueInputSchema>;
export type ReverseReservationRevenueInput = z.infer<typeof reverseReservationRevenueInputSchema>;

export type PropertyOwnerShare = {
  ownerId: string;
  ownerName: string;
  shareBps: number;
};

export type OwnerGrossAllocation = PropertyOwnerShare & {
  grossAmount: Money;
};

export type OwnerCommissionAllocation = OwnerGrossAllocation & {
  commissionRateBps: number;
  commissionAmount: Money;
  netAmount: Money;
};

export type FinancePostingDraft = {
  ledgerAccountId: string;
  side: LedgerSide;
  amount: Money;
  bucket: string;
  dimensions: Record<string, unknown>;
};

export function parseRecordReservationRevenueInput(input: unknown) {
  return recordReservationRevenueInputSchema.safeParse(input);
}

export function parseReverseReservationRevenueInput(input: unknown) {
  return reverseReservationRevenueInputSchema.safeParse(input);
}

export function parseCommissionRuleValue(input: unknown): CommissionRuleValue {
  return commissionRuleValueSchema.parse(input);
}

export function allocateGrossRevenueByOwnerShare(
  total: Money,
  owners: readonly PropertyOwnerShare[]
): OwnerGrossAllocation[] {
  if (owners.length === 0) {
    throw new Error("A reservation must have at least one active property owner");
  }

  const totalShareBps = owners.reduce((sum, owner) => sum + owner.shareBps, 0);
  if (totalShareBps !== 10000) {
    throw new Error("Active property owner shares must total 10000 bps");
  }
  if (owners.some(owner => !Number.isSafeInteger(owner.shareBps) || owner.shareBps < 0 || owner.shareBps > 10000))
    throw new Error("Active property owner shares must be nonnegative basis points");

  let allocated = Money.zero(total.currency);

  return owners.map((owner, index) => {
    const remaining = total.subtract(allocated), proportional = total.multiply(new Decimal(owner.shareBps).div("10000"));
    const grossAmount = index === owners.length - 1 || proportional.amount.gt(remaining.amount) ? remaining : proportional;
    allocated = allocated.add(grossAmount);

    return {
      ...owner,
      grossAmount
    };
  });
}

export function calculateOwnerCommission(input: {
  ownerGrossAmount: Money;
  commissionRateBps: number;
}): Money {
  if (!Number.isInteger(input.commissionRateBps) || input.commissionRateBps < 0 || input.commissionRateBps > 10000) {
    throw new Error("Commission rate must be between 0 and 10000 bps");
  }

  return input.ownerGrossAmount.multiply(new Decimal(input.commissionRateBps).div("10000"));
}

export function withCommissionAllocations(
  grossAllocations: readonly OwnerGrossAllocation[],
  rateForOwner: (ownerId: string) => number
): OwnerCommissionAllocation[] {
  return grossAllocations.map((allocation) => {
    const commissionRateBps = rateForOwner(allocation.ownerId);
    const commissionAmount = calculateOwnerCommission({
      ownerGrossAmount: allocation.grossAmount,
      commissionRateBps
    });

    return {
      ...allocation,
      commissionRateBps,
      commissionAmount,
      netAmount: allocation.grossAmount.subtract(commissionAmount)
    };
  });
}

export function assertFinancePostingsBalanced(postings: readonly FinancePostingDraft[]): void {
  assertBalancedPostings(postings.map((posting) => ({ side: posting.side, amount: posting.amount })));
}
