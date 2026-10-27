import { z } from "zod";
import type { Money } from "@/platform/money/money";
import { financialTransferSchema } from "./financial-transfer";
import { assertFinancePostingsBalanced, type FinancePostingDraft } from "./reservation-revenue";

export const ownerPayoutStates = ["DRAFT", "PENDING_APPROVAL", "APPROVED", "SCHEDULED", "PAID", "RECONCILED", "FAILED", "CANCELLED"] as const;
export type OwnerPayoutState = (typeof ownerPayoutStates)[number];
export type OwnerPayoutCommand = "submit" | "approve" | "schedule" | "pay" | "reconcile" | "fail" | "cancel" | "reverse";

const id = z.uuid().transform(value => value.toLowerCase());
export const ownerPayoutDraftSchema = z.object({
  propertyId: id,
  ownerId: id,
  reservationId: id.optional(),
  payoutMethodId: id,
  fundingAccountId: id,
  amount: financialTransferSchema.shape.amount,
  currency: financialTransferSchema.shape.currency,
  purpose: financialTransferSchema.shape.purpose,
  reason: financialTransferSchema.shape.reason,
  idempotencyKey: financialTransferSchema.shape.idempotencyKey
}).strict();

const transitions: Record<OwnerPayoutState, Partial<Record<OwnerPayoutCommand, OwnerPayoutState>>> = {
  DRAFT: { submit: "PENDING_APPROVAL", cancel: "CANCELLED" },
  PENDING_APPROVAL: { approve: "APPROVED", cancel: "CANCELLED" },
  APPROVED: { schedule: "SCHEDULED", cancel: "CANCELLED" },
  SCHEDULED: { pay: "PAID", fail: "FAILED", cancel: "CANCELLED" },
  PAID: { reconcile: "RECONCILED", reverse: "CANCELLED" },
  RECONCILED: {},
  FAILED: {},
  CANCELLED: {}
};

/** Evidence for approval, settlement and exact reversal is checked by the command service. */
export function ownerPayoutNextState(state: OwnerPayoutState, command: OwnerPayoutCommand): OwnerPayoutState {
  const next = transitions[state][command];
  if (!next) throw new Error("Owner payout transition is not permitted");
  return next;
}

/** Paying an owner reduces the ownership claim and the actual funding location together. */
export function ownerPayoutPostings(input: {
  payoutId: string;
  ownerId: string;
  propertyId: string;
  reservationId?: string;
  ownerPayableAccountId: string;
  fundingAccountId: string;
  amount: Money;
}): FinancePostingDraft[] {
  if (!input.amount.amount.gt(0) || input.ownerPayableAccountId === input.fundingAccountId) {
    throw new Error("Owner payout requires positive money and distinct ownership and funding accounts");
  }
  const dimensions = {
    source: "OWNER_PAYOUT",
    payout_id: input.payoutId,
    owner_id: input.ownerId,
    property_id: input.propertyId,
    ...(input.reservationId ? { reservation_id: input.reservationId } : {})
  };
  const postings: FinancePostingDraft[] = [
    { ledgerAccountId: input.ownerPayableAccountId, side: "DEBIT", amount: input.amount, bucket: "PAYOUT", dimensions },
    { ledgerAccountId: input.fundingAccountId, side: "CREDIT", amount: input.amount, bucket: "PAYOUT_PAYMENT", dimensions }
  ];
  assertFinancePostingsBalanced(postings);
  return postings;
}
