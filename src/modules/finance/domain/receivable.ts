import {z} from "zod";
import {Money} from "@/platform/money/money";

export const receivablePolicyKey="finance.receivables";
export class ReceivableAccessError extends Error{}
export class ReceivablePolicyError extends Error{}
export const receivablePolicySchema=z.object({
  source:z.literal("POSTED_OWNERSHIP_CLAIMS"),
  account_codes:z.array(z.string().regex(/^[A-Z][A-Z0-9_]*$/u)).min(1)
    .refine(codes=>new Set(codes).size===codes.length,"Account codes must be unique")
}).strict();

export const receivableSummaryInput=z.object({fromOn:z.iso.date(),toOn:z.iso.date(),
  timezone:z.string().min(1).max(100).refine(value=>{try{new Intl.DateTimeFormat("en",{timeZone:value});return true;}catch{return false;}}),
  currency:z.string().regex(/^[A-Z]{3}$/u)
}).strict().refine(value=>value.fromOn<=value.toOn,{path:["toOn"],message:"End must follow start"});

export type ReceivableAccountTotals={
  id:string;code:string;name:string;accountType:string;normalSide:string;currency:string;
  opening:string;debits:string;credits:string;count:string;
};

/** Ownership claims remain separate from the place where money is held. */
export function receivableAccountBalances(rows:readonly ReceivableAccountTotals[],currency:string){
  let opening=Money.zero(currency),debits=Money.zero(currency),credits=Money.zero(currency),count=0n;
  const ids=new Set<string>(),codes=new Set<string>();
  const accounts=rows.map(row=>{
    if(row.accountType!=="CLAIM_OWNERSHIP"||row.normalSide!=="DEBIT"||row.currency!==currency||
      ids.has(row.id)||codes.has(row.code))throw Error("Receivable ownership account evidence is inconsistent");
    ids.add(row.id);codes.add(row.code);
    if(!/^(?:0|[1-9]\d*)$/u.test(row.count))throw Error("Receivable movement count is invalid");
    const before=Money.of(row.opening,currency),dr=Money.of(row.debits,currency),cr=Money.of(row.credits,currency);
    if(dr.amount.isNegative()||cr.amount.isNegative())throw Error("Posted movement totals must be nonnegative");
    opening=opening.add(before);debits=debits.add(dr);credits=credits.add(cr);count+=BigInt(row.count);
    return{id:row.id,code:row.code,name:row.name,openingBalance:before.toJSON().amount,
      periodDebits:dr.toJSON().amount,periodCredits:cr.toJSON().amount,
      closingBalance:before.add(dr).subtract(cr).toJSON().amount,rowCount:row.count};
  });
  return{currency,openingBalance:opening.toJSON().amount,periodDebits:debits.toJSON().amount,
    periodCredits:credits.toJSON().amount,closingBalance:opening.add(debits).subtract(credits).toJSON().amount,
    rowCount:count.toString(),accounts};
}
