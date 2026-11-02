import type {NextRequest} from "next/server";
import {getTranslations} from "next-intl/server";
import {exportReceivableAgingCsv} from "@/modules/finance/application/receivable-export-service";
import {receivableExportColumns,receivableExportInput,type ReceivableExportLabels} from "@/modules/finance/domain/receivable-export";
import {compensationHttp} from "@/modules/finance/ui/compensation-http";

function csvStream(records:Generator<string,void,unknown>){const encoder=new TextEncoder();return new ReadableStream<Uint8Array>({pull(controller){const rows:string[]=[];let done=false;for(let i=0;i<128;i++){const next=records.next();if(next.done){done=true;break;}rows.push(next.value);}if(rows.length)controller.enqueue(encoder.encode(rows.join("")));if(done)controller.close();},cancel(){records.return(undefined);}});}

export async function POST(request:NextRequest){
 return compensationHttp(request,async(actor,raw,requestId)=>{
  const input=receivableExportInput.parse(raw),[t,aging,common]=await Promise.all([getTranslations({locale:input.locale,namespace:"ReceivableExports"}),getTranslations({locale:input.locale,namespace:"ReceivableAging"}),getTranslations({locale:input.locale,namespace:"Receivables"})]),
   labels:ReceivableExportLabels={headers:Object.fromEntries(receivableExportColumns.map(key=>[key,t(`columns.${key}`)])) as ReceivableExportLabels["headers"],claim:t("claim"),total:t("total"),unscheduled:aging("unscheduled"),notDue:aging("notDue"),kinds:{GUEST:common("kinds.GUEST"),OWNER:common("kinds.OWNER"),SUPPLIER:common("kinds.SUPPLIER"),PERSON:common("kinds.PERSON")}},
   file=await exportReceivableAgingCsv(actor,input,labels,{requestId});
  return{...file,requestId,fileName:t("fileName",{date:file.on,currency:file.currency})};
 },{json:true,maxBytes:16384,rejectQuery:true,feature:"finance.receivable_export",respond:file=>{
  const encoded=encodeURIComponent(file.fileName).replace(/['()*]/gu,value=>"%"+value.charCodeAt(0).toString(16).toUpperCase());
  return new Response(csvStream(file.records()),{headers:{"Content-Type":"text/csv; charset=utf-8","Content-Disposition":`attachment; filename="receivables-${file.on}-${file.currency}.csv"; filename*=UTF-8''${encoded}`,"X-Content-Type-Options":"nosniff","X-Request-ID":file.requestId}});
 }});
}
