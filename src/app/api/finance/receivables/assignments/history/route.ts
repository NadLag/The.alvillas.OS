import type {NextRequest} from "next/server";
import {compensationHttp} from "@/modules/finance/ui/compensation-http";
import {getReceivableAssignmentHistory} from "@/modules/finance/application/receivable-workspace";
export const runtime="nodejs";
export async function POST(request:NextRequest){return compensationHttp(request,(actor,input,requestId)=>getReceivableAssignmentHistory(actor,input,{requestId}),{rejectQuery:true,json:true,feature:"receivable-assignment-history"});}
