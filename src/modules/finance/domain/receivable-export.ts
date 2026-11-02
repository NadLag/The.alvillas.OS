import {z} from "zod";
import {appLocales,type AppLocale} from "@/i18n/routing";
import {localizedText} from "@/i18n/content";
import {Money} from "@/platform/money/money";
import {receivableAgingInput,receivableAgingPageSchema,receivableAgingAmounts,ReceivableAgingSourceError} from "./receivable-aging";
import type {receivablePartyKind} from "./receivable-assignment";

export const receivableExportInput=z.object({query:receivableAgingInput.refine(value=>value.after===undefined),locale:z.enum(appLocales),reason:z.string().trim().min(6).max(1000)}).strict();
export class ReceivableExportRateLimitError extends Error{constructor(readonly resetAt:Date){super("receivable_export_rate_limited");}}
export const receivableExportSourceSchema=receivableAgingPageSchema.shape.source.extend({items:z.array(receivableAgingPageSchema.shape.source.shape.items.element),next:z.null()});
export const receivableExportColumns=["recordType","asOf","civilOn","timezone","currency","agingRuleId","agingRuleVersion","assignmentId","postingId","partyKind","partyId","purpose","dueOn","daysPastDue","band","assigned","collected","outstanding","claimCount"] as const;
export type ReceivableExportLabels={headers:Record<typeof receivableExportColumns[number],string>;claim:string;total:string;unscheduled:string;notDue:string;kinds:Record<z.infer<typeof receivablePartyKind>,string>};

/** Free text cannot become a spreadsheet formula; verified decimal and integer columns retain their exact bytes. */
function csvCell(value:string,numeric=false){
 const safe=numeric?value:/^[=+@-]/u.test(value.replace(/^[\s\p{Cc}]*/u,""))?"'"+value:value;
 if(numeric&&!/^-?(?:0|[1-9]\d*)(?:\.\d{2})?$/u.test(value))throw new ReceivableAgingSourceError();
 return '"'+safe.replaceAll('"','""')+'"';
}
const numericColumns=new Set([6,13,15,16,17,18]);
const csvRow=(values:readonly string[],header=false)=>values.map((value,index)=>csvCell(value,!header&&value!==""&&numericColumns.has(index))).join(",")+"\r\n";

/** Validate the complete snapshot before a response can expose any bytes. Pagination is never silently exported. */
export function receivableAgingCsv(raw:unknown,locale:AppLocale,labels:ReceivableExportLabels){
 const parsed=receivableExportSourceSchema.safeParse(raw);if(!parsed.success)throw new ReceivableAgingSourceError();
 const source=parsed.data,currency=source.currency,ids=new Set<string>(),groups=new Map<string,{count:bigint;amount:Money}>();
 for(const group of source.buckets){if(groups.has(group.key)||group.outstanding.currency!==currency||group.labels===null&&!["UNSCHEDULED","NOT_DUE"].includes(group.key))throw new ReceivableAgingSourceError();groups.set(group.key,{count:0n,amount:Money.zero(currency)});}
 let assigned=Money.zero(currency),collected=Money.zero(currency),outstanding=Money.zero(currency);
 for(const item of source.items){
  if(ids.has(item.id)||![item.assigned,item.collected,item.outstanding].every(value=>value.currency===currency))throw new ReceivableAgingSourceError();ids.add(item.id);
  const amount=receivableAgingAmounts(item.assigned.amount,item.collected.amount,currency),group=groups.get(item.bucket);
  if(!group||amount.outstanding.amount!==item.outstanding.amount||!Money.of(item.outstanding.amount,currency).amount.gt(0))throw new ReceivableAgingSourceError();
  assigned=assigned.add(Money.of(item.assigned.amount,currency));collected=collected.add(Money.of(item.collected.amount,currency));outstanding=outstanding.add(Money.of(item.outstanding.amount,currency));group.count++;group.amount=group.amount.add(Money.of(item.outstanding.amount,currency));
 }
 if(source.totalOutstanding.currency!==currency||BigInt(source.totalCount)!==BigInt(source.items.length)||!outstanding.equals(Money.of(source.totalOutstanding.amount,currency)))throw new ReceivableAgingSourceError();
 for(const bucket of source.buckets){const group=groups.get(bucket.key)!;if(group.count!==BigInt(bucket.count)||!group.amount.equals(Money.of(bucket.outstanding.amount,currency)))throw new ReceivableAgingSourceError();}
 const metadata=[source.at,source.on,source.timezone,currency,source.rule.id,String(source.rule.version)],bands=new Map(source.buckets.map(bucket=>[bucket.key,bucket.labels?localizedText(bucket.labels,locale):bucket.key==="UNSCHEDULED"?labels.unscheduled:labels.notDue]));
 function* records(){
  yield "\uFEFF"+csvRow(receivableExportColumns.map(column=>labels.headers[column]),true);
  yield csvRow([labels.total,...metadata,"","","","","","","","",assigned.toJSON().amount,collected.toJSON().amount,outstanding.toJSON().amount,source.totalCount]);
  for(const item of source.items)yield csvRow([labels.claim,...metadata,item.id,item.postingId,labels.kinds[item.party.kind],item.party.id,item.purpose,item.dueOn??"",item.daysPastDue===null?"":String(item.daysPastDue),bands.get(item.bucket)!,item.assigned.amount,item.collected.amount,item.outstanding.amount,"1"]);
 }
 return{count:source.totalCount,currency,on:source.on,records};
}
