import {z} from "zod";
import {receivablePolicySchema} from "@/modules/finance/domain/receivable";
import {receivableCollectionMethodSchema} from "@/modules/finance/domain/receivable-collection-policy";

export const guestDepositPolicyKey="finance.guest_deposits";
const accountCodes=receivablePolicySchema.shape.account_codes;
export const guestDepositKindSchema=z.object({
 key:z.string().regex(/^[a-z][a-z0-9_.-]{0,119}$/u),
 labels:receivableCollectionMethodSchema.shape.labels,
 liability_account_code:z.string().regex(/^GUEST_(?:PREPAYMENT|DEPOSIT)(?:_[A-Z0-9_]+)?$/u),
 application:z.enum(["ACCOMMODATION_PREPAYMENT","REFUND_ONLY"])
}).strict();
/** No rate, forfeiture, tax treatment, refund deadline or recognition decision is defaulted here. */
export const guestDepositPolicySchema=z.object({
 source:z.literal("ACTUAL_GUEST_RECEIPT"),
 kinds:z.array(guestDepositKindSchema).min(1).refine(rows=>new Set(rows.map(row=>row.key)).size===rows.length,"Deposit kind keys must be unique"),
 receipt_account_codes:accountCodes,
 refund_account_codes:accountCodes,
 receipt_bucket:z.string().regex(/^[A-Z][A-Z0-9_]{0,119}$/u),
 refund_bucket:z.string().regex(/^[A-Z][A-Z0-9_]{0,119}$/u),
 payment_methods:z.array(receivableCollectionMethodSchema).min(1).refine(rows=>new Set(rows.map(row=>row.key)).size===rows.length,"Payment method keys must be unique"),
 refund_limit:z.literal("ORIGINAL_UNAPPLIED_UNREFUNDED_LIABILITY"),
 closed_period:z.literal("REJECT"),
 correction_date:z.literal("CURRENT_OPEN_PERIOD")
}).strict();
export type GuestDepositPolicy=z.infer<typeof guestDepositPolicySchema>;
