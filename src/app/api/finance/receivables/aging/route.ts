import type {NextRequest} from "next/server";
import {compensationHttp} from "@/modules/finance/ui/compensation-http";
import {getReceivableAging} from "@/modules/finance/application/receivable-aging-service";
export const runtime="nodejs";
export async function POST(request:NextRequest){return compensationHttp(request,(actor,input,requestId)=>getReceivableAging(actor,input,{requestId}),{rejectQuery:true,json:true,maxBytes:16384,feature:"receivable-aging"});}
