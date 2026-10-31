import {Money} from "@/platform/money/money";

/** A journal counts once per currency even when several retained sources refer to it. */
export function financialJournalExposure(sources:readonly {transactionId:string;currency:string;amount:string}[]){
 const journals=new Map<string,Money>(),totals=new Map<string,Money>();
 for(const source of sources){
  if(!source.transactionId)throw Error("Original journal identity is required");
  const amount=Money.of(source.amount,source.currency),key=source.transactionId+":"+source.currency,existing=journals.get(key);
  if(amount.amount.isNegative()||existing&&!existing.equals(amount))throw Error("Original journal exposure is inconsistent");
  if(!existing){journals.set(key,amount);totals.set(source.currency,(totals.get(source.currency)??Money.zero(source.currency)).add(amount));}
 }
 return totals;
}
