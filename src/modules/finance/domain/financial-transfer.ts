import { z } from "zod";
import { Money } from "@/platform/money/money";
import type { FinancePostingDraft } from "./reservation-revenue";
import { isExpenseFundingAccount } from "./expense";

export {financialTransferKinds,financialTransferSchema} from "./financial-transfer-input";
import type {FinancialTransferInput} from "./financial-transfer-input";
export type {FinancialTransferInput};
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
