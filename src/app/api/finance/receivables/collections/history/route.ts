import type {NextRequest} from "next/server";
import {compensationHttp} from "@/modules/finance/ui/compensation-http";
import {getReceivableCollectionHistory} from "@/modules/finance/application/receivable-collection-workspace";
export const runtime="nodejs";
export async function POST(request:NextRequest){return compensationHttp(request,(actor,input,requestId)=>getReceivableCollectionHistory(actor,input,{requestId}),{rejectQuery:true,json:true,feature:"receivable-collection-history"});}
