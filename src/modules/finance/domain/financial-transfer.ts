import { z } from "zod";
import Decimal from "decimal.js";
import { Money } from "@/platform/money/money";
import type { FinancePostingDraft } from "./reservation-revenue";
import { isExpenseFundingAccount } from "./expense";

export const financialTransferKinds = ["TRANSFER", "ADVANCE", "RETURN"] as const;
export const financialTransferSchema = z.object({
  fromAccountId: z.uuid().transform(value=>value.toLowerCase()), toAccountId: z.uuid().transform(value=>value.toLowerCase()),
  kind: z.enum(financialTransferKinds), amount: z.string().regex(/^(?:0|[1-9]\d{0,15})(?:\.\d{1,2})?$/u)
    .pipe(z.string().refine(value=>new Decimal(value).gt(0)).transform(value=>new Decimal(value).toFixed(2))),
  currency: z.string().regex(/^[A-Z]{3}$/u), purpose: z.string().trim().min(3).max(500),
  reason: z.string().trim().min(6).max(500), idempotencyKey: z.uuid().transform(value=>value.toLowerCase())
}).strict().refine(value=>value.fromAccountId!==value.toAccountId,{path:["toAccountId"],message:"Distinct accounts required"});
export type FinancialTransferInput = z.infer<typeof financialTransferSchema>;
export const financialTransferVoidSchema = z.object({ id: z.uuid().transform(value=>value.toLowerCase()), reason: z.string().trim().min(6).max(500) }).strict();
export const isTransferLocation = isExpenseFundingAccount;
export function transferKindMatches(kind: FinancialTransferInput["kind"], from: Parameters<typeof isExpenseFundingAccount>[0], to: Parameters<typeof isExpenseFundingAccount>[0]): boolean {
  const source=from.accountType==="STAFF_WALLET",destination=to.accountType==="STAFF_WALLET";
  return kind==="ADVANCE"?!source&&destination:kind==="RETURN"?source&&!destination:source===destination;
}
export function financialTransferPostings(input: FinancialTransferInput): FinancePostingDraft[] {
  const amount=Money.of(input.amount,input.currency),dimensions={ transfer_id:input.idempotencyKey,from_account_id:input.fromAccountId,
    to_account_id:input.toAccountId,kind:input.kind,source:"TRANSFER" };
  return [{ledgerAccountId:input.toAccountId,side:"DEBIT",amount,bucket:input.kind,dimensions},
    {ledgerAccountId:input.fromAccountId,side:"CREDIT",amount,bucket:input.kind,dimensions}];
}
