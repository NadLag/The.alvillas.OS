import type {NextRequest} from "next/server";
import {compensationHttp} from "@/modules/finance/ui/compensation-http";
import {createReceivableAssignment} from "@/modules/finance/application/receivable-assignment-service";
export const runtime="nodejs";
export async function POST(request:NextRequest){return compensationHttp(request,(actor,input,requestId)=>createReceivableAssignment(actor,input,{requestId}),{rejectQuery:true,json:true,feature:"receivable-assignment-create"});}
