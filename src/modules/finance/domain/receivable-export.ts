import {z} from "zod";
import {spreadsheetCsvCell} from "@/platform/exports/spreadsheet-cell";
import {appLocales,type AppLocale} from "@/i18n/routing";
import {localizedText} from "@/i18n/content";
import {receivableAgingInput,receivableAgingCompleteSourceSchema,receivableAgingCompleteSource,ReceivableAgingSourceError} from "./receivable-aging";
import type {receivablePartyKind} from "./receivable-assignment";

export const receivableExportInput=z.object({query:receivableAgingInput.refine(value=>value.after===undefined),locale:z.enum(appLocales),reason:z.string().trim().min(6).max(1000)}).strict();
export class ReceivableExportRateLimitError extends Error{constructor(readonly resetAt:Date){super("receivable_export_rate_limited");}}
export const receivableExportSourceSchema=receivableAgingCompleteSourceSchema;
export const receivableExportColumns=["recordType","asOf","civilOn","timezone","currency","agingRuleId","agingRuleVersion","assignmentId","postingId","partyKind","partyId","purpose","dueOn","daysPastDue","band","assigned","collected","outstanding","claimCount"] as const;
export type ReceivableExportLabels={headers:Record<typeof receivableExportColumns[number],string>;claim:string;total:string;unscheduled:string;notDue:string;kinds:Record<z.infer<typeof receivablePartyKind>,string>};

/** Free text cannot become a spreadsheet formula; verified decimal and integer columns retain their exact bytes. */
function csvCell(value:string,numeric=false){
 if(numeric&&!/^-?(?:0|[1-9]\d*)(?:\.\d{2})?$/u.test(value))throw new ReceivableAgingSourceError();
 return spreadsheetCsvCell(value,numeric);
}
const numericColumns=new Set([6,13,15,16,17,18]);
const csvRow=(values:readonly string[],header=false)=>values.map((value,index)=>csvCell(value,!header&&value!==""&&numericColumns.has(index))).join(",")+"\r\n";

/** Validate the complete snapshot before a response can expose any bytes. Pagination is never silently exported. */
export function receivableAgingCsv(raw:unknown,locale:AppLocale,labels:ReceivableExportLabels){
 const{source,assigned,collected,outstanding}=receivableAgingCompleteSource(raw),currency=source.currency;
 const metadata=[source.at,source.on,source.timezone,currency,source.rule.id,String(source.rule.version)],bands=new Map(source.buckets.map(bucket=>[bucket.key,bucket.labels?localizedText(bucket.labels,locale):bucket.key==="UNSCHEDULED"?labels.unscheduled:labels.notDue]));
 function* records(){
  yield "\uFEFF"+csvRow(receivableExportColumns.map(column=>labels.headers[column]),true);
  yield csvRow([labels.total,...metadata,"","","","","","","","",assigned.toJSON().amount,collected.toJSON().amount,outstanding.toJSON().amount,source.totalCount]);
  for(const item of source.items)yield csvRow([labels.claim,...metadata,item.id,item.postingId,labels.kinds[item.party.kind],item.party.id,item.purpose,item.dueOn??"",item.daysPastDue===null?"":String(item.daysPastDue),bands.get(item.bucket)!,item.assigned.amount,item.collected.amount,item.outstanding.amount,"1"]);
 }
 return{count:source.totalCount,currency,on:source.on,records};
}
