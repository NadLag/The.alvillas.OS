import{z}from"zod";
import type{Money}from"@/platform/money/money";
import{assertBalancedPostings}from"@/platform/ledger/ledger";
import{isExpenseFundingAccount}from"./expense";
import type{FinanceLedgerAccount}from"../infrastructure/finance-repository";
import type{FinancePostingDraft}from"./reservation-revenue";
import{receivableCollectionPolicySchema}from"./receivable-collection-policy";
import{receivableCollectionMethodSchema}from"./receivable-collection-policy";
import{receivableAssignmentViewSchema}from"./receivable-assignment";
import{employeePercentageScopeReferences}from"./employee-percentage-source-scope";
export{receivableCollectionPolicyKey,receivableCollectionPolicySchema}from"./receivable-collection-policy";
const id=z.uuid().transform(value=>value.toLowerCase()),moneyText=z.string().regex(/^(?:0|[1-9]\d{0,15})(?:\.\d{1,2})?$/u).refine(value=>/[1-9]/u.test(value)),instant=z.iso.datetime({precision:3});
export const receivableCollectionReviewInput=z.object({assignmentId:id,destinationAccountId:id,amount:moneyText,currency:z.string().regex(/^[A-Z]{3}$/u),method:z.string().regex(/^[a-z][a-z0-9_.-]{0,119}$/u),receivedAt:instant,externalReference:z.string().trim().max(160).nullable(),purpose:z.string().trim().min(3).max(1000)}).strict();
export const receivableCollectionInput=receivableCollectionReviewInput.extend({idempotencyKey:id,reviewFingerprint:z.string().regex(/^[a-f0-9]{64}$/u),reason:z.string().trim().min(6).max(500)}).strict();
export const receivableCollectionVoidReviewInput=z.object({id}).strict();
export const receivableCollectionVoidInput=receivableCollectionVoidReviewInput.extend({idempotencyKey:id,reviewFingerprint:z.string().regex(/^[a-f0-9]{64}$/u),reason:z.string().trim().min(6).max(500)}).strict();
export const receivableCollectionRecoveryInput=z.object({key:id}).strict();
const moneyValue=receivableAssignmentViewSchema.shape.amount;
export const receivableCollectionViewSchema=z.object({id,assignmentId:id,sourcePostingId:id,transactionId:id,destinationAccountId:id,party:receivableAssignmentViewSchema.shape.party,amount:moneyValue,
 method:receivableCollectionMethodSchema,receivedAt:instant,externalReference:z.string().nullable(),purpose:z.string(),reason:z.string(),createdBy:id,createdAt:z.iso.datetime(),
 reversal:z.object({id,transactionId:id,reason:z.string(),createdBy:id,createdAt:z.iso.datetime()}).strict().nullable()}).strict();
export const receivableCollectionReceiptSchema=z.object({collection:receivableCollectionViewSchema,idempotencyKey:id,operation:z.enum(["COLLECT","REVERSE"]),idempotent:z.boolean()}).strict();
export const receivableCollectionReviewSchema=z.object({source:z.object({assignmentId:id,party:receivableAssignmentViewSchema.shape.party,sourcePostingId:id,sourceTransactionId:id,sourceOccurredAt:instant,assignedAmount:moneyValue,outstandingAmount:moneyValue}).strict(),
 collection:z.object({amount:moneyValue,method:receivableCollectionMethodSchema,destination:z.object({id,name:z.string(),code:z.string()}).strict(),receivedAt:instant,externalReference:z.string().nullable(),purpose:z.string()}).strict(),reviewFingerprint:z.string().regex(/^[a-f0-9]{64}$/u)}).strict();
export const receivableCollectionVoidReviewSchema=z.object({collection:receivableCollectionViewSchema,calendar:z.object({ruleId:id,version:z.number().int().positive(),timezone:z.string()}).strict(),reviewFingerprint:z.string().regex(/^[a-f0-9]{64}$/u)}).strict();
export class ReceivableCollectionSourceError extends Error{}
export class ReceivableCollectionConflictError extends Error{}

/** The caller supplies totals from actual posted movements; no balance is stored or clamped. */
export function receivableCollectionOutstanding(assigned:Money,collected:Money){
 if(assigned.currency!==collected.currency||assigned.amount.lt(0)||collected.amount.lt(0)||collected.amount.gt(assigned.amount))throw new ReceivableCollectionConflictError();
 return assigned.subtract(collected);
}

export function receivableCollectionActualInstant(receivedAt:string,originalOccurredAt:Date,now:Date,rawPolicy:unknown){
 receivableCollectionPolicySchema.parse(rawPolicy);const parsed=instant.safeParse(receivedAt);if(!parsed.success||!Number.isFinite(originalOccurredAt.getTime())||!Number.isFinite(now.getTime()))throw new ReceivableCollectionSourceError();
 const actual=new Date(parsed.data);if(actual<originalOccurredAt||actual>now)throw new ReceivableCollectionConflictError();return actual;
}

/** Receipt location and the original ownership claim remain distinct in one balanced journal. */
export function receivableCollectionPostings(input:{assignmentId:string;sourcePostingId:string;sourceDimensions:unknown;collectionId:string;receivableAccount:FinanceLedgerAccount;destination:FinanceLedgerAccount;amount:Money;outstanding:Money;method:string;policy:unknown}):FinancePostingDraft[]{
 const policy=receivableCollectionPolicySchema.parse(input.policy),{receivableAccount,destination,amount,outstanding}=input;
 if(![input.assignmentId,input.sourcePostingId,input.collectionId,receivableAccount.id,destination.id].every(value=>z.uuid().safeParse(value).success)||receivableAccount.id===destination.id||
  receivableAccount.accountType!=="CLAIM_OWNERSHIP"||receivableAccount.normalSide!=="DEBIT"||receivableAccount.archivedAt||!isExpenseFundingAccount(destination)||
  !policy.destination_account_codes.includes(destination.code)||!policy.payment_methods.some(method=>method.key===input.method))throw new ReceivableCollectionSourceError();
 if(amount.currency!==outstanding.currency||!amount.amount.gt(0)||outstanding.amount.lt(0)||amount.amount.gt(outstanding.amount))throw new ReceivableCollectionConflictError();
 const dimensions={...employeePercentageScopeReferences(input.sourceDimensions),source:"RECEIVABLE_COLLECTION",receivable_collection_id:input.collectionId,receivable_assignment_id:input.assignmentId,original_posting_id:input.sourcePostingId,payment_method:input.method},
  rows:FinancePostingDraft[]=[{ledgerAccountId:destination.id,side:"DEBIT",amount,bucket:policy.bucket,dimensions},{ledgerAccountId:receivableAccount.id,side:"CREDIT",amount,bucket:policy.bucket,dimensions}];
 assertBalancedPostings(rows);return rows;
}
