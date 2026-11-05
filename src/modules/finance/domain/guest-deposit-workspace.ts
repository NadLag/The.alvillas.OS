import {z} from "zod";
import {guestDepositKindSchema} from "@/platform/config/guest-deposit-policy";
import {receivableCollectionMethodSchema} from "./receivable-collection-policy";
import {guestDepositReviewInput,guestDepositRefundReviewInput,guestDepositReversalReviewInput,guestDepositCashAdmissionReviewInput,guestDepositFundedApplicationReviewInput} from "./guest-deposit-command";
const id=z.uuid().transform(value=>value.toLowerCase()),cursor=z.string().min(1).max(2048),instant=z.iso.datetime(),query=z.string().trim().max(120).default("");
const money=z.object({amount:z.string().regex(/^(?:0|[1-9]\d*)(?:\.\d{2})$/u),currency:z.string().regex(/^[A-Z]{3}$/u)}).strict();
export const guestDepositWorkspaceReadSchema=z.discriminatedUnion("operation",[
 guestDepositFundedApplicationReviewInput.extend({operation:z.literal("REVIEW_APPLICATION")}),
 z.object({operation:z.literal("CASH_SOURCES"),reservationId:id,after:cursor.optional()}).strict(),
 guestDepositCashAdmissionReviewInput.extend({operation:z.literal("REVIEW_CASH_ADMISSION")}),
 z.object({operation:z.literal("SOURCES"),after:cursor.optional(),query}).strict(),
 z.object({operation:z.literal("LIST"),after:cursor.optional(),query}).strict(),
 z.object({operation:z.literal("DETAIL"),depositId:id,before:cursor.optional()}).strict(),
 z.object({operation:z.literal("OPTIONS"),reservationId:id,receivedAt:z.iso.datetime({precision:3}).optional(),afterAccount:cursor.optional(),accountQuery:query,selectedAccountId:id.optional()}).strict(),
 z.object({operation:z.literal("REFUND_OPTIONS"),depositId:id,afterAccount:cursor.optional(),accountQuery:query,selectedAccountId:id.optional()}).strict(),
 guestDepositReviewInput.extend({operation:z.literal("REVIEW_RECEIPT")}),
 guestDepositRefundReviewInput.extend({operation:z.literal("REVIEW_REFUND")}),
 guestDepositReversalReviewInput.extend({operation:z.literal("REVIEW_REVERSE")})
]);
export const guestDepositSourcesSchema=z.object({items:z.array(z.object({reservationId:id,reference:z.string(),propertyName:z.string(),guestName:z.string().nullable()}).strict()).max(50),next:cursor.nullable(),canAdmitCash:z.boolean().default(false)}).strict();
export const guestDepositSummarySchema=z.object({depositId:id,transactionId:id,reservationId:id,reservationReference:z.string(),propertyId:id,propertyName:z.string(),guestName:z.string().nullable(),kind:guestDepositKindSchema,amount:money,outstanding:money,receivedAt:instant,purpose:z.string(),externalReference:z.string().nullable(),cashOrigin:z.object({collectionId:id,transactionId:id,custodyAccountId:id,custodyName:z.string(),receivedAt:instant}).strict().nullable().default(null),reversed:z.boolean()}).strict();
export const guestDepositListSchema=z.object({items:z.array(guestDepositSummarySchema).max(50),next:cursor.nullable(),canCreate:z.boolean()}).strict();
const account=z.object({id,name:z.string(),code:z.string()}).strict();
export const guestDepositCashSourcesSchema=z.object({reservationId:id,kinds:z.array(guestDepositKindSchema),methods:z.array(receivableCollectionMethodSchema.extend({currencies:z.array(z.string().regex(/^[A-Z]{3}$/u))})).nullable().default(null),items:z.array(z.object({collectionId:id,amount:money,available:money,receivedAt:instant,purpose:z.string(),custody:account}).strict()).max(50),next:cursor.nullable(),canAdmit:z.boolean()}).strict();
export const guestDepositCashReviewSchema=z.object({collectionId:id,reservationId:id,kind:guestDepositKindSchema,amount:money,available:money,receivedAt:instant,custody:account,reviewFingerprint:z.string().regex(/^[a-f0-9]{64}$/u),paymentMethodFingerprint:z.string().regex(/^[a-f0-9]{64}$/u).optional(),paymentMethod:receivableCollectionMethodSchema.optional()}).strict();
export const guestDepositOptionsSchema=z.object({now:instant,timeZone:z.string(),baseCurrency:z.string(),currencies:z.array(z.object({code:z.string(),minorUnit:z.number().int().min(0).max(2)}).strict()),kinds:z.array(guestDepositKindSchema),methods:z.array(receivableCollectionMethodSchema.extend({currencies:z.array(z.string().regex(/^[A-Z]{3}$/u)).optional()})),accounts:z.array(account).max(50),selected:account.nullable(),accountsNext:cursor.nullable(),canCreate:z.boolean()}).strict();
export const guestDepositDetailSchema=z.object({summary:guestDepositSummarySchema,canRefund:z.boolean(),canApply:z.boolean().default(false),applicationLimit:money.nullable().default(null),movements:z.array(z.object({id,operation:z.enum(["RECEIPT","ADMIT_CASH","REFUND","APPLY","APPLICATION_ADJUSTMENT","REVERSE_APPLICATION","REVERSE_RECEIPT","REVERSE_CASH_ADMISSION","REVERSE_REFUND"]),amount:money,occurredAt:instant,locationName:z.string(),purpose:z.string(),reason:z.string(),externalReference:z.string().nullable(),reversesTransactionId:id.nullable(),reversed:z.boolean(),canReverse:z.boolean()}).strict()).max(50),next:cursor.nullable()}).strict();
export const guestDepositReceiptReviewSchema=z.object({reservationId:id,kind:guestDepositKindSchema,amount:money,location:account,receivedAt:instant,reviewFingerprint:z.string().regex(/^[a-f0-9]{64}$/u),paymentMethodFingerprint:z.string().regex(/^[a-f0-9]{64}$/u).optional()}).strict();
export const guestDepositRefundReviewSchema=z.object({depositId:id,originalTransactionId:id,originalAmount:money,outstanding:money,amount:money,location:account,reviewFingerprint:z.string().regex(/^[a-f0-9]{64}$/u)}).strict();
export const guestDepositApplicationReviewSchema=z.object({depositId:id,amount:money,outstanding:money,quote:money,applied:money,commissionDelta:money.extend({amount:z.string().regex(/^-?(?:0|[1-9]\d*)\.\d{2}$/u)}),checkoutRevisionId:id,reviewFingerprint:z.string().regex(/^[a-f0-9]{64}$/u)}).strict();
export const guestDepositReversalReviewSchema=z.object({depositId:id,transactionId:id,operation:z.enum(["RECEIPT","ADMIT_CASH","REFUND","APPLY"]),amount:money,outstanding:money,allocationAdjustmentRequired:z.boolean().default(false),reviewFingerprint:z.string().regex(/^[a-f0-9]{64}$/u)}).strict();
export type GuestDepositSummary=z.infer<typeof guestDepositSummarySchema>;
export type GuestDepositDetail=z.infer<typeof guestDepositDetailSchema>;
