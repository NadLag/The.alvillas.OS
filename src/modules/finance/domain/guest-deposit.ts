import {z} from "zod";
import type {Money} from "@/platform/money/money";
import {assertBalancedPostings} from "@/platform/ledger/ledger";
import {guestDepositPolicySchema} from "@/platform/config/guest-deposit-policy";
import {isExpenseFundingAccount} from "./expense";
import type {FinancePostingDraft} from "./reservation-revenue";

const identity=z.uuid().transform(value=>value.toLowerCase());
export {guestDepositReviewInput,guestDepositReceiptInput,guestDepositRefundReviewInput,guestDepositRefundInput,guestDepositRecoveryInput} from "./guest-deposit-command";
export class GuestDepositSourceError extends Error{}
export class GuestDepositConflictError extends Error{}
export class GuestDepositAuthorizationError extends Error{}
export class GuestDepositConfigurationError extends Error{}

/** All three totals come from sealed movements, including their exact opposite corrections. */
export function guestDepositOutstanding(received:Money,refunded:Money,applied:Money):Money{
 if(received.currency!==refunded.currency||received.currency!==applied.currency||[received,refunded,applied].some(value=>value.amount.lt(0)))throw new GuestDepositSourceError();
 const remaining=received.subtract(refunded).subtract(applied);if(remaining.amount.lt(0))throw new GuestDepositConflictError();return remaining;
}

export type GuestDepositSource={organizationId:string;depositId:string;reservationId:string;propertyId:string;guestId:string;kind:string};
type DepositAccount=Parameters<typeof isExpenseFundingAccount>[0]&{id:string};
type JournalInput={source:GuestDepositSource;location:DepositAccount;liability:DepositAccount;amount:Money;method:string;policy:unknown;originalPolicy?:unknown};
function prepare(input:JournalInput,operation:"RECEIPT"|"REFUND"){
 const {source,location,liability,amount}=input,parsed=guestDepositPolicySchema.safeParse(input.policy);if(!parsed.success)throw new GuestDepositConfigurationError();
 const policy=parsed.data,original=operation==="REFUND"?guestDepositPolicySchema.safeParse(input.originalPolicy):parsed;
 if(!original.success)throw new GuestDepositConfigurationError();const kind=original.data.kinds.find(row=>row.key===source.kind);
 if(!kind||!policy.payment_methods.some(row=>row.key===input.method))throw new GuestDepositConfigurationError();
 if(![source.organizationId,source.depositId,source.reservationId,source.propertyId,source.guestId,location.id,liability.id].every(value=>identity.safeParse(value).success)||
  location.id===liability.id||!isExpenseFundingAccount(location)||!policy[operation==="RECEIPT"?"receipt_account_codes":"refund_account_codes"].includes(location.code)||
  liability.code!==kind.liability_account_code||liability.accountType!=="CLAIM_OWNERSHIP"||liability.normalSide!=="CREDIT"||liability.archivedAt||!amount.amount.gt(0))throw new GuestDepositSourceError();
 return{policy,dimensions:{source:"GUEST_DEPOSIT",deposit_operation:operation,deposit_id:source.depositId,reservation_id:source.reservationId,property_id:source.propertyId,guest_id:source.guestId,deposit_kind:kind.key,payment_method:input.method}};
}

/** A receipt changes location and guest liability together; it earns no owner or company revenue. */
export function guestDepositReceiptPostings(input:JournalInput):FinancePostingDraft[]{
 const {policy,dimensions}=prepare(input,"RECEIPT"),rows:FinancePostingDraft[]=[
  {ledgerAccountId:input.location.id,side:"DEBIT",amount:input.amount,bucket:policy.receipt_bucket,dimensions},
  {ledgerAccountId:input.liability.id,side:"CREDIT",amount:input.amount,bucket:policy.receipt_bucket,dimensions}
 ];assertBalancedPostings(rows);return rows;
}

/** A refund consumes only this original guest deposit's remaining liability, in its original currency. */
export function guestDepositRefundPostings(input:JournalInput&{originalPolicy:unknown;outstanding:Money;refundId:string;originalTransactionId:string}):FinancePostingDraft[]{
 const {policy,dimensions}=prepare(input,"REFUND");if(!identity.safeParse(input.refundId).success||!identity.safeParse(input.originalTransactionId).success)throw new GuestDepositSourceError();
 if(input.amount.currency!==input.outstanding.currency||input.outstanding.amount.lt(0)||input.amount.amount.gt(input.outstanding.amount))throw new GuestDepositConflictError();
 const original={...dimensions,deposit_refund_id:input.refundId,original_transaction_id:input.originalTransactionId},rows:FinancePostingDraft[]=[
  {ledgerAccountId:input.liability.id,side:"DEBIT",amount:input.amount,bucket:policy.refund_bucket,dimensions:original},
  {ledgerAccountId:input.location.id,side:"CREDIT",amount:input.amount,bucket:policy.refund_bucket,dimensions:original}
 ];assertBalancedPostings(rows);return rows;
}
