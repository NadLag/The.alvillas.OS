import {z} from "zod";
import {Money} from "@/platform/money/money";
import {assertBalancedPostings} from "@/platform/ledger/ledger";
import type {FinancePostingDraft} from "./reservation-revenue";

const dimensions=z.record(z.string(),z.json());
function canonical(value:unknown):unknown{
 if(Array.isArray(value))return value.map((item:unknown)=>canonical(item));
 if(value!==null&&typeof value==="object"){
  const entries:Array<[string,unknown]>=Object.entries(value);
  return Object.fromEntries(entries.sort(([left],[right])=>left<right?-1:left>right?1:0).map(([key,item])=>[key,canonical(item)]));
 }
 return value;
}

/** Differences between canonical native targets; this chooses no owner, rate, rule or recognition event. */
export function guestDepositApplicationVectorDelta(before:readonly FinancePostingDraft[],after:readonly FinancePostingDraft[]):FinancePostingDraft[]{
 const entries=new Map<string,{posting:FinancePostingDraft;amount:Money}>();
 for(const[rows,subtract]of[[before,true],[after,false]]as const){
  if(rows.length)assertBalancedPostings(rows);
  for(const row of rows){
   const account=z.uuid().parse(row.ledgerAccountId).toLowerCase(),metadata=dimensions.parse(row.dimensions);
   if(!["DEBIT","CREDIT"].includes(row.side)||row.amount.amount.lt(0))throw Error("A native target requires nonnegative postings with an explicit side");
   const key=JSON.stringify([account,row.bucket,row.amount.currency,canonical(metadata)]),signed=row.side==="DEBIT"?row.amount:Money.zero(row.amount.currency).subtract(row.amount),delta=subtract?Money.zero(signed.currency).subtract(signed):signed,entry=entries.get(key);
   entries.set(key,{posting:{...row,ledgerAccountId:account,dimensions:metadata},amount:entry?entry.amount.add(delta):delta});
  }
 }
 const result:FinancePostingDraft[]=[];
 for(const[,entry]of[...entries].sort(([left],[right])=>left<right?-1:left>right?1:0)){
  if(entry.amount.amount.isZero())continue;
  result.push({...entry.posting,side:entry.amount.amount.gt(0)?"DEBIT":"CREDIT",amount:Money.of(entry.amount.amount.abs(),entry.amount.currency)});
 }
 if(result.length)assertBalancedPostings(result);
 return result;
}
