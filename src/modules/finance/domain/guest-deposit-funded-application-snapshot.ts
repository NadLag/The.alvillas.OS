import {z} from "zod";
import {guestDepositReceiptSnapshot,guestDepositReversalSnapshot} from "./guest-deposit-snapshot";
import {guestDepositFundedApplicationInput} from "./guest-deposit-command";
const id=z.uuid().transform(value=>value.toLowerCase()),amount=z.string().regex(/^(?:0|[1-9]\d*)\.\d{2}$/u);
export const guestDepositNativeApplicationPosting=z.object({ledgerAccountId:id,side:z.enum(["DEBIT","CREDIT"]),amount,currency:z.string().regex(/^[A-Z]{3}$/u),bucket:z.string().nullable(),dimensions:z.record(z.string(),z.json())}).strict();
export const guestDepositFundedApplicationSnapshot=guestDepositReceiptSnapshot.omit({operation:true,input:true}).extend({
 operation:z.literal("APPLY"),input:guestDepositFundedApplicationInput,originalTransactionId:id,
 checkoutRevisionId:id,confirmationRevisionId:id,financialSnapshotId:id,
 appliedBefore:amount,appliedAfter:amount,ownerPayableAccountId:id,commissionRevenueAccountId:id,
 nativeBefore:z.array(guestDepositNativeApplicationPosting),nativeAfter:z.array(guestDepositNativeApplicationPosting),
 originalOwnerOrder:z.array(id).min(1)
}).strict();
export const guestDepositFundedApplicationReversalSnapshot=guestDepositReversalSnapshot.extend({applicationCorrection:z.object({
 originalSnapshot:guestDepositFundedApplicationSnapshot,appliedBefore:amount,appliedAfter:amount,
 nativeBefore:z.array(guestDepositNativeApplicationPosting),nativeAfter:z.array(guestDepositNativeApplicationPosting),
 adjustmentTransactionId:id.nullable()
}).strict()}).strict();
