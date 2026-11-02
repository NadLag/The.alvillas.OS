import {z} from "zod";
import {Money} from "@/platform/money/money";
import {assertBalancedPostings} from "@/platform/ledger/ledger";
import {receivablePolicySchema} from "./receivable";
import {employeePostedJournalAmounts} from "./employee-percentage-posted-base";

export const receivablePartyKind=z.enum(["GUEST","OWNER","SUPPLIER","PERSON"]);
export const receivableAssignmentPolicyKey="finance.receivable_assignments";
export const receivableAssignmentPolicySchema=z.object({source:z.literal("ORIGINAL_POSTED_DEBIT"),
  party_types:z.array(receivablePartyKind).min(1).refine(items=>new Set(items).size===items.length,"Party types must be unique"),
  due_date:z.literal("EXPLICIT_OR_UNSCHEDULED")
}).strict();
const id=z.uuid().transform(value=>value.toLowerCase());
const moneyText=z.string().regex(/^(?:0|[1-9]\d{0,15})(?:\.\d{1,2})?$/u);
const amount=moneyText.pipe(z.string().refine(value=>BigInt(value.replace(".",""))>0n));
export const receivableAssignmentReviewInput=z.object({postingId:id,partyKind:receivablePartyKind,partyId:id,
  amount,currency:z.string().regex(/^[A-Z]{3}$/u),dueOn:z.iso.date().nullable(),purpose:z.string().trim().min(3).max(1000)
}).strict();
export const receivableAssignmentCreateInput=receivableAssignmentReviewInput.extend({idempotencyKey:id,reviewFingerprint:z.string().regex(/^[a-f0-9]{64}$/u),reason:z.string().trim().min(6).max(500)}).strict();
export const receivableAssignmentReleaseReviewInput=z.object({id}).strict();
export const receivableAssignmentReleaseInput=receivableAssignmentReleaseReviewInput.extend({idempotencyKey:id,reviewFingerprint:z.string().regex(/^[a-f0-9]{64}$/u),reason:z.string().trim().min(6).max(500)}).strict();
const moneyValue=z.object({amount:z.string().regex(/^-?(?:0|[1-9]\d*)\.\d{2}$/u),currency:z.string().regex(/^[A-Z]{3}$/u)}).strict();
export const receivableAssignmentViewSchema=z.object({id,postingId:id,party:z.object({kind:receivablePartyKind,id}).strict(),amount:moneyValue,dueOn:z.iso.date().nullable(),purpose:z.string(),reason:z.string(),createdBy:id,createdAt:z.iso.datetime(),
  release:z.object({id,reason:z.string(),createdBy:id,createdAt:z.iso.datetime()}).strict().nullable()}).strict();
export const receivableAssignmentReceiptSchema=z.object({assignment:receivableAssignmentViewSchema,idempotent:z.boolean(),idempotencyKey:id,operation:z.enum(["ASSIGN","RELEASE"])}).strict();
export const receivableAssignmentReviewSchema=z.object({assignment:z.object({party:z.object({kind:receivablePartyKind,id}).strict(),amount:moneyValue,dueOn:z.iso.date().nullable(),purpose:z.string()}).strict(),
  source:z.object({postingId:id,transactionId:id,originalAmount:moneyValue,unassignedAmount:moneyValue,occurredAt:z.iso.datetime()}).strict(),reviewFingerprint:z.string().regex(/^[a-f0-9]{64}$/u)}).strict();
export const receivableAssignmentReleaseReviewSchema=z.object({assignment:receivableAssignmentViewSchema,reviewFingerprint:z.string().regex(/^[a-f0-9]{64}$/u)}).strict();
export class ReceivableAssignmentSourceError extends Error{}
export class ReceivableAssignmentConflictError extends Error{}
type Amount={toString():string};
export type ReceivablePostedClaimSource={
  posting:{id:string;organizationId:string;transactionId:string;ledgerAccountId:string;side:string;amount:Amount;currency:string};
  transaction:{id:string;organizationId:string;occurredAt:Date;sealed:boolean;reversesTransactionId:string|null;reversedByTransactions:readonly{id:string}[];
    postings:readonly{id:string;ledgerAccountId:string;side:string;amount:Amount;currency:string}[]};
  account:{id:string;organizationId:string;code:string;accountType:string;normalSide:string};
};

/** An allocation identifies the original debtor; it never creates another financial movement. */
export function receivablePostedClaim(organizationId:string,currency:string,rawPolicy:unknown,source:ReceivablePostedClaimSource,now:Date){
  const policy=receivablePolicySchema.parse(rawPolicy),{posting,transaction,account}=source;
  if(![organizationId,posting.id,transaction.id,account.id].every(value=>z.uuid().safeParse(value).success)||
    [posting.organizationId,transaction.organizationId,account.organizationId].some(value=>value!==organizationId)||posting.transactionId!==transaction.id||posting.ledgerAccountId!==account.id||
    !transaction.sealed||transaction.reversesTransactionId!==null||transaction.reversedByTransactions.length||!Number.isFinite(transaction.occurredAt.getTime())||!Number.isFinite(now.getTime())||transaction.occurredAt>now||
    posting.currency!==currency||posting.side!=="DEBIT"||account.accountType!=="CLAIM_OWNERSHIP"||account.normalSide!=="DEBIT"||!policy.account_codes.includes(account.code))throw new ReceivableAssignmentSourceError();
  const original=transaction.postings.find(row=>row.id===posting.id);
  if(!original||original.ledgerAccountId!==posting.ledgerAccountId||original.side!==posting.side||original.currency!==currency||original.amount.toString()!==posting.amount.toString()||new Set(transaction.postings.map(row=>row.id)).size!==transaction.postings.length)throw new ReceivableAssignmentSourceError();
  try{
    const postings=transaction.postings.map(row=>{if(!["DEBIT","CREDIT"].includes(row.side)||typeof row.amount==="number"||!moneyText.safeParse(row.amount.toString()).success)throw new ReceivableAssignmentSourceError();const value=Money.of(row.amount.toString(),row.currency);if(!value.amount.gt(0))throw new ReceivableAssignmentSourceError();return{side:row.side as "DEBIT"|"CREDIT",amount:value};});
    assertBalancedPostings(postings);const value=Money.of(posting.amount.toString(),currency);if(!value.amount.gt(0))throw new ReceivableAssignmentSourceError();
    return{postingId:posting.id,transactionId:transaction.id,ledgerAccountId:account.id,occurredAt:transaction.occurredAt,amount:value,journalAmounts:employeePostedJournalAmounts(transaction.postings)};
  }catch(error){if(error instanceof ReceivableAssignmentSourceError)throw error;throw new ReceivableAssignmentSourceError();}
}

export function receivableUnassignedAmount(original:Money,assigned:Money){
  if(original.currency!==assigned.currency||original.amount.lt(0)||assigned.amount.lt(0)||assigned.amount.gt(original.amount))throw new ReceivableAssignmentSourceError();
  return original.subtract(assigned);
}

/** Every exact original-journal opposite contributes its allocated share, without changing the assignment. */
export function receivableOriginalPosition(assigned:Money,oppositeJournalIds:readonly string[]){
  if(assigned.amount.lt(0)||new Set(oppositeJournalIds).size!==oppositeJournalIds.length||oppositeJournalIds.some(value=>!z.uuid().safeParse(value).success))throw new ReceivableAssignmentSourceError();
  return assigned.multiplyRatio(1n-BigInt(oppositeJournalIds.length),1n);
}
