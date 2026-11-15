import {Money} from "@/platform/money/money";

export type RecognizedServiceOrderAmounts={sourceId:string;collectionId:string;postingId:string;transactionId:string;costIds:readonly string[];gross:Money;companyRevenue:Money;providerCost:Money;ownerAmount:Money;taxAmount:Money};
export class ServiceOrderFinancialIntegrityError extends Error{}

/** Page totals come only from actual active native recognitions. Quotes and
 * catalog internal-cost estimates are never inputs to recognized margin. */
export function serviceOrderFinancialPageTotals(currency:string,rows:readonly RecognizedServiceOrderAmounts[]){
 const identities=new Set<string>(),totals={gross:Money.zero(currency),companyRevenue:Money.zero(currency),providerCost:Money.zero(currency),ownerAmount:Money.zero(currency),taxAmount:Money.zero(currency)};
 for(const row of rows){
  for(const identity of["source:"+row.sourceId,"collection:"+row.collectionId,"posting:"+row.postingId,"journal:"+row.transactionId,...row.costIds.map(id=>"cost:"+id)]){if(identities.has(identity))throw new ServiceOrderFinancialIntegrityError();identities.add(identity);}
  if(!row.gross.equals(row.companyRevenue.add(row.ownerAmount).add(row.taxAmount)))throw new ServiceOrderFinancialIntegrityError();
  for(const key of Object.keys(totals)as Array<keyof typeof totals>){const value=row[key];if(!(value instanceof Money)||value.currency!==currency||value.amount.lt(0))throw new ServiceOrderFinancialIntegrityError();totals[key]=totals[key].add(value);}
 }
 return{recognized:rows.length,...Object.fromEntries(Object.entries(totals).map(([key,value])=>[key,value.toJSON().amount])),margin:totals.companyRevenue.subtract(totals.providerCost).toJSON().amount};
}
