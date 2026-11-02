import type{NextRequest}from"next/server";
import{compensationHttp}from"@/modules/finance/ui/compensation-http";
import{getReceivableReminderSettings,saveReceivableReminderSettings}from"@/modules/finance/application/receivable-reminder-settings-service";
export const runtime="nodejs";
export function GET(request:NextRequest){return compensationHttp(request,(actor,_input,requestId)=>getReceivableReminderSettings(actor,{requestId}),{rejectQuery:true,feature:"receivable-reminder-settings"});}
export function POST(request:NextRequest){return compensationHttp(request,(actor,input,requestId)=>saveReceivableReminderSettings(actor,input,{requestId}),{json:true,rejectQuery:true,feature:"receivable-reminder-settings"});}
