import {z} from "zod";
const identity=z.uuid().transform(value=>value.toLowerCase()),hash=z.string().regex(/^[a-f0-9]{64}$/u),reason=z.string().trim().min(6).max(500);
const positiveMoney=z.string().regex(/^(?:0|[1-9]\d{0,15})(?:\.\d{1,2})?$/u).refine(value=>/[1-9]/u.test(value));
const moneyInput={amount:positiveMoney,currency:z.string().regex(/^[A-Z]{3}$/u)};
const receiptFacts={reservationId:identity,kind:z.string().regex(/^[a-z][a-z0-9_.-]{0,119}$/u),accountId:identity,...moneyInput,
 method:z.string().regex(/^[a-z][a-z0-9_.-]{0,119}$/u),receivedAt:z.iso.datetime({precision:3}),externalReference:z.string().trim().max(160).nullable(),purpose:z.string().trim().min(3).max(1000)};
export const guestDepositReviewInput=z.object(receiptFacts).strict();
export const guestDepositReceiptInput=guestDepositReviewInput.extend({reviewFingerprint:hash,idempotencyKey:identity,reason}).strict();
export const guestDepositRefundReviewInput=z.object({depositId:identity,accountId:identity,...moneyInput,method:receiptFacts.method,externalReference:receiptFacts.externalReference,purpose:receiptFacts.purpose}).strict();
export const guestDepositRefundInput=guestDepositRefundReviewInput.extend({reviewFingerprint:hash,idempotencyKey:identity,reason}).strict();
export const guestDepositRecoveryInput=z.object({key:identity}).strict();
export const guestDepositReversalReviewInput=z.object({transactionId:identity}).strict();
export const guestDepositReversalInput=guestDepositReversalReviewInput.extend({reviewFingerprint:hash,idempotencyKey:identity,reason}).strict();
export const guestDepositCommandSchema=z.discriminatedUnion("operation",[
 z.object({operation:z.literal("RECEIPT"),input:guestDepositReceiptInput.omit({idempotencyKey:true}),idempotencyKey:identity}).strict(),
 z.object({operation:z.literal("REFUND"),input:guestDepositRefundInput.omit({idempotencyKey:true}),idempotencyKey:identity}).strict(),
 z.object({operation:z.literal("REVERSE"),input:guestDepositReversalInput.omit({idempotencyKey:true}),idempotencyKey:identity}).strict()
]);
const operation=z.enum(["RECEIPT","REFUND","REVERSE"]),base={requestId:identity,idempotencyKey:identity,operation};
export const guestDepositCommandSuccessSchema=z.object({...base,state:z.literal("SUCCEEDED"),failureCode:z.null(),id:identity,depositId:identity,idempotent:z.boolean()}).strict();
export const guestDepositCommandResultSchema=z.union([guestDepositCommandSuccessSchema,z.object({...base,state:z.literal("CONFLICT"),failureCode:z.enum(["SOURCE_CHANGED","ORIGINAL_REQUEST_RECORDED"])}).strict(),z.object({...base,state:z.literal("FAILED"),failureCode:z.enum(["CONFIGURATION_UNAVAILABLE","SOURCE_UNAVAILABLE","PERIOD_CLOSED"])}).strict()]);
export const guestDepositCommandRecoverySchema=z.object({request:guestDepositCommandSuccessSchema.nullable()}).strict();
export type GuestDepositCommand=z.infer<typeof guestDepositCommandSchema>;
