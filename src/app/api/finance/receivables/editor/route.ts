import type {NextRequest} from "next/server";
import {compensationHttp} from "@/modules/finance/ui/compensation-http";
import {getReceivableEditor} from "@/modules/finance/application/receivable-workspace";
export const runtime="nodejs";
export async function GET(request:NextRequest){return compensationHttp(request,(actor,_input,requestId)=>getReceivableEditor(actor,{requestId}),{rejectQuery:true,feature:"receivable-editor"});}
