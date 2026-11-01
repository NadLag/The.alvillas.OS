import type {NextRequest} from "next/server";
import {compensationHttp} from "@/modules/finance/ui/compensation-http";
import {getReceivableSummary} from "@/modules/finance/application/receivable-summary-service";
export const runtime="nodejs";
export async function POST(request:NextRequest){return compensationHttp(request,(actor,input,requestId)=>getReceivableSummary(actor,input,{requestId}),{rejectQuery:true,json:true,feature:"receivable-summary"});}
