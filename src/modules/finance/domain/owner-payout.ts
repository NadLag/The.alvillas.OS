import { z } from "zod";
import type { Money } from "@/platform/money/money";
import { financialTransferSchema } from "./financial-transfer";
import { assertFinancePostingsBalanced, type FinancePostingDraft } from "./reservation-revenue";
import type { Action, Resource } from "@/platform/authz/authorize";
import { expenseFundingWalletResource } from "./expense";

export const ownerPayoutStates = ["DRAFT", "PENDING_APPROVAL", "APPROVED", "SCHEDULED", "PAID", "RECONCILED", "FAILED", "CANCELLED"] as const;
export type OwnerPayoutState = (typeof ownerPayoutStates)[number];
export type OwnerPayoutCommand = "submit" | "approve" | "schedule" | "pay" | "reconcile" | "fail" | "cancel" | "reverse";

const id = z.uuid().transform(value => value.toLowerCase());
export const ownerPayoutDraftSchema = z.object({
  propertyId: id,
  ownerId: id,
  reservationId: id.optional(),
  expectedSettlementAt: z.iso.datetime({ offset: true }).transform(value => new Date(value).toISOString()).optional(),
  payoutMethodId: id,
  fundingAccountId: id,
  amount: financialTransferSchema.shape.amount,
  currency: financialTransferSchema.shape.currency,
  purpose: financialTransferSchema.shape.purpose,
  reason: financialTransferSchema.shape.reason,
  idempotencyKey: financialTransferSchema.shape.idempotencyKey
}).strict();

export const ownerPayoutCommandSchema = z.object({ id, expectedVersion: z.number().int().positive(), reason: financialTransferSchema.shape.reason }).strict();
export const ownerPayoutScheduleSchema = ownerPayoutCommandSchema.extend({ scheduledFor: z.iso.datetime({offset:true}).transform(value=>new Date(value).toISOString()) }).strict();
export const ownerPayoutPaymentSchema = ownerPayoutCommandSchema.extend({ paymentReference:z.string().trim().min(3).max(160) }).strict();
export const payoutClockOccurrence=z.enum(["reject","earlier","later"]);
export const ownerPayoutDraftFormSchema=ownerPayoutDraftSchema.omit({expectedSettlementAt:true}).extend({expectedSettlementLocal:z.string().trim().min(1).max(32).optional(),
  occurrence:payoutClockOccurrence.default("reject")}).strict();
export const ownerPayoutScheduleFormSchema=ownerPayoutCommandSchema.extend({scheduledLocal:z.string().trim().min(1).max(32),occurrence:payoutClockOccurrence.default("reject")}).strict();
export function ownerPayoutWorkspacePath(locale:string,ownerId:string,propertyId:string){return`/${locale}/app/finance/owner-ledgers/properties/${propertyId}/owners/${ownerId}/payouts`;}

export function ownerPayoutResource(organizationId:string,row:{id:string;ownerId:string;propertyId:string;amount:{toString():string};state:string;createdBy:string;
  reservationId?:string|null;createdAt?:Date;paidAt?:Date|null},property:{cityId:string|null;regionId:string|null}):Resource {
  return {type:"financial_transaction",organizationId,id:row.id,financialRecordId:row.id,ownerId:row.ownerId,propertyId:row.propertyId,
    reservationId:row.reservationId,amount:row.amount.toString(),status:row.state,assignedUserAccountId:row.createdBy,
    occurredAt:row.paidAt??row.createdAt,city:property.cityId,region:property.regionId,dataClass:"financial"};
}

export function ownerPayoutFundingChecks(organizationId:string,funding:Parameters<typeof expenseFundingWalletResource>[1]&{id:string},amount:string,at:Date,action:"pay"|"void"):Array<{action:Action;resource:Resource}>{
  const target:Resource={type:"financial_transaction",organizationId,id:funding.id,financialRecordId:funding.id,amount,occurredAt:at,dataClass:"financial"};
  const wallet=expenseFundingWalletResource(organizationId,funding,amount,at);
  return[{action:"view",resource:target},{action,resource:target},...(wallet?[{action:"view" as const,resource:wallet},{action,resource:wallet}]:[])];
}

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
