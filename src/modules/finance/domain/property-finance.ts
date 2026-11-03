import {z} from "zod";
import {Money} from "@/platform/money/money";
export{propertyFinanceFinancialSources,propertyFinancePartySources,propertyFinanceAuthorityChecks,canViewCompletePropertyFinance}from"@/platform/authz/property-finance-resource";

export const propertyFinanceFilters=z.object({propertyId:z.uuid().transform(value=>value.toLowerCase()),fromOn:z.iso.date().optional(),toOn:z.iso.date().optional(),currency:z.string().regex(/^[A-Z]{3}$/u).optional(),after:z.string().min(1).max(8192).optional()}).strict().refine(value=>!value.fromOn||!value.toOn||value.fromOn<=value.toOn,{path:["toOn"],message:"End must follow start"});
const nonnegative=z.string().regex(/^(?:0|[1-9]\d*)(?:\.\d{1,2})?$/u);
export const propertyFinanceAccountFactsSchema=z.object({id:z.uuid(),name:z.string(),accountType:z.string(),normalSide:z.enum(["DEBIT","CREDIT"]),currency:z.string().regex(/^[A-Z]{3}$/u),openingDebits:nonnegative,openingCredits:nonnegative,periodDebits:nonnegative,periodCredits:nonnegative,postingCount:z.string().regex(/^\d+$/u)}).strict();
export type PropertyFinanceAccountFacts=z.infer<typeof propertyFinanceAccountFactsSchema>;
/** An account's attributed position follows its native normal side. Ownership and location stay separate. */
export function propertyFinanceAccountPositions(raw:readonly PropertyFinanceAccountFacts[]){
 const seen=new Set<string>();return raw.map(input=>{
  const row=propertyFinanceAccountFactsSchema.parse(input),key=row.id+":"+row.currency;if(seen.has(key))throw new Error("Duplicate property account and currency");seen.add(key);
  const openingDebits=Money.of(row.openingDebits,row.currency),openingCredits=Money.of(row.openingCredits,row.currency),debits=Money.of(row.periodDebits,row.currency),credits=Money.of(row.periodCredits,row.currency);
  const opening=row.normalSide==="DEBIT"?openingDebits.subtract(openingCredits):openingCredits.subtract(openingDebits),closing=row.normalSide==="DEBIT"?opening.add(debits).subtract(credits):opening.add(credits).subtract(debits);
  return{id:row.id,name:row.name,accountType:row.accountType,normalSide:row.normalSide,currency:row.currency,opening:opening.toJSON().amount,debits:debits.toJSON().amount,credits:credits.toJSON().amount,closing:closing.toJSON().amount,postingCount:row.postingCount};
 });
}
export class PropertyFinanceAccessError extends Error{}
export class PropertyFinanceConfigurationError extends Error{}
export class PropertyFinanceSourceChangedError extends Error{}
const id=z.uuid(),money=z.string(),position=z.object({id,name:z.string(),accountType:z.string(),normalSide:z.enum(["DEBIT","CREDIT"]),currency:z.string(),opening:money,debits:money,credits:money,closing:money,postingCount:z.string()}).strict();
export const propertyFinanceViewSchema=z.object({property:z.object({id,name:z.string(),timezone:z.string(),archived:z.boolean()}).strict(),fromOn:z.iso.date(),toOn:z.iso.date(),currency:z.string(),currencies:z.array(z.string()),accounts:z.array(position),
 items:z.array(z.object({id,transactionId:id,reference:z.string(),occurredAt:z.iso.datetime({offset:true}),description:z.string().nullable(),side:z.enum(["DEBIT","CREDIT"]),amount:money,currency:z.string(),bucket:z.string().nullable(),accountId:id,accountName:z.string(),accountType:z.string(),normalSide:z.enum(["DEBIT","CREDIT"]),reversesTransactionId:id.nullable(),expenseId:id.nullable(),invoiceId:id.nullable(),employeeSubmissionId:id.nullable(),employeeClaimId:id.nullable()}).strict()),next:z.string().nullable(),capabilities:z.object({createExpense:z.boolean(),audit:z.boolean()}).strict()}).strict();
export type PropertyFinanceView=z.infer<typeof propertyFinanceViewSchema>;
