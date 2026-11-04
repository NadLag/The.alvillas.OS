import {z} from "zod";
import {assertBalancedPostings} from "@/platform/ledger/ledger";
import type {Money} from "@/platform/money/money";
import {guestDepositPolicySchema,type GuestDepositPolicy} from "@/platform/config/guest-deposit-policy";
import {GuestDepositSourceError,GuestDepositConflictError,GuestDepositConfigurationError,type GuestDepositSource,type guestDepositReceiptPostings} from "./guest-deposit";
import type {FinancePostingDraft} from "./reservation-revenue";

type Account=Parameters<typeof guestDepositReceiptPostings>[0]["liability"];
type Input={source:GuestDepositSource;kind:GuestDepositPolicy["kinds"][number];liability:Account;receivable:Account;amount:Money;outstanding:Money;receivableOutstanding:Money;applicationId:string;originalTransactionId:string;receivableAssignmentId:string;receivablePostingId:string;policy:unknown};
/** Applies held guest liability to an actual accommodation claim without another receipt or another earning. */
export function guestDepositApplicationPostings(input:Input):FinancePostingDraft[]{
 const {source,kind,liability,amount}=input;
 if(![source.organizationId,source.depositId,source.reservationId,source.propertyId,source.guestId,liability.id,input.receivable.id,input.applicationId,input.originalTransactionId,input.receivableAssignmentId,input.receivablePostingId].every(id=>z.uuid().safeParse(id).success))throw new GuestDepositSourceError();
 if(kind.key!==source.kind||kind.application!=="ACCOMMODATION_PREPAYMENT"||liability.code!==kind.liability_account_code||liability.accountType!=="CLAIM_OWNERSHIP"||liability.normalSide!=="CREDIT"||liability.archivedAt||!amount.amount.gt(0))throw new GuestDepositSourceError();
 const selected=guestDepositPolicySchema.safeParse(input.policy);if(!selected.success||!selected.data.application)throw new GuestDepositConfigurationError();const policy=selected.data.application;
 if(input.receivable.id===liability.id||input.receivable.code!==policy.receivable_account_code||input.receivable.accountType!=="CLAIM_OWNERSHIP"||input.receivable.normalSide!=="DEBIT"||input.receivable.archivedAt)throw new GuestDepositSourceError();
 if(amount.currency!==input.outstanding.currency||amount.currency!==input.receivableOutstanding.currency||input.outstanding.amount.lt(0)||input.receivableOutstanding.amount.lt(0)||amount.amount.gt(input.outstanding.amount)||amount.amount.gt(input.receivableOutstanding.amount))throw new GuestDepositConflictError();
 const dimensions={source:"GUEST_DEPOSIT",reservation_id:source.reservationId,property_id:source.propertyId,guest_id:source.guestId,deposit_id:source.depositId,deposit_kind:source.kind,deposit_operation:"APPLICATION",deposit_application_id:input.applicationId,original_transaction_id:input.originalTransactionId,receivable_assignment_id:input.receivableAssignmentId,receivable_posting_id:input.receivablePostingId},result:FinancePostingDraft[]=[{ledgerAccountId:liability.id,side:"DEBIT",amount,bucket:policy.bucket,dimensions},{ledgerAccountId:input.receivable.id,side:"CREDIT",amount,bucket:policy.bucket,dimensions}];
 assertBalancedPostings(result);return result;
}
