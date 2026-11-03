import {z} from "zod";
import type {Money} from "@/platform/money/money";
import {assertBalancedPostings} from "@/platform/ledger/ledger";
import {guestDepositPolicySchema} from "@/platform/config/guest-deposit-policy";
import {GuestDepositConfigurationError,GuestDepositConflictError,GuestDepositSourceError,type GuestDepositSource,type guestDepositReceiptPostings} from "./guest-deposit";
import type {FinancePostingDraft} from "./reservation-revenue";
type Account=Parameters<typeof guestDepositReceiptPostings>[0]["liability"];
/** Changes ownership of an original collection; physical custody stays on its original ledger. */
export function guestDepositCashAdmissionPostings(input:{source:GuestDepositSource;collectionId:string;collectionTransactionId:string;taskId:string;taskType:string;unallocated:Account;liability:Account;amount:Money;available:Money;policy:unknown}):FinancePostingDraft[]{
 const {source,amount,unallocated,liability}=input,selected=guestDepositPolicySchema.safeParse(input.policy);if(!selected.success||!selected.data.cash_admission)throw new GuestDepositConfigurationError();const policy=selected.data,kind=policy.kinds.find(row=>row.key===source.kind);
 if(![source.organizationId,source.depositId,source.reservationId,source.propertyId,source.guestId,input.collectionId,input.collectionTransactionId,input.taskId,unallocated.id,liability.id].every(id=>z.uuid().safeParse(id).success)||!kind||!policy.cash_admission!.task_types.includes(input.taskType)||unallocated.id===liability.id||unallocated.code!=="UNALLOCATED_COLLECTIONS"||unallocated.accountType!=="CLAIM_OWNERSHIP"||unallocated.normalSide!=="CREDIT"||unallocated.archivedAt||liability.code!==kind.liability_account_code||liability.accountType!=="CLAIM_OWNERSHIP"||liability.normalSide!=="CREDIT"||liability.archivedAt||!amount.amount.gt(0))throw new GuestDepositSourceError();
 if(amount.currency!==input.available.currency||input.available.amount.lt(0)||amount.amount.gt(input.available.amount))throw new GuestDepositConflictError();
 const dimensions={source:"GUEST_DEPOSIT",deposit_operation:"CASH_ADMISSION",deposit_id:source.depositId,deposit_kind:source.kind,property_id:source.propertyId,reservation_id:source.reservationId,guest_id:source.guestId,cash_collection_id:input.collectionId,original_collection_transaction_id:input.collectionTransactionId,task_id:input.taskId},rows:FinancePostingDraft[]=[{ledgerAccountId:unallocated.id,side:"DEBIT",amount,bucket:policy.cash_admission!.bucket,dimensions},{ledgerAccountId:liability.id,side:"CREDIT",amount,bucket:policy.cash_admission!.bucket,dimensions}];assertBalancedPostings(rows);return rows;
}
