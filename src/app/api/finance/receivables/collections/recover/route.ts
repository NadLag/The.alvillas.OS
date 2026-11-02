import type {NextRequest} from "next/server";
import {compensationHttp} from "@/modules/finance/ui/compensation-http";
import {recoverReceivableCollection} from "@/modules/finance/application/receivable-collection-service";
export const runtime="nodejs";
export async function POST(request:NextRequest){return compensationHttp(request,(actor,input,requestId)=>recoverReceivableCollection(actor,input,{requestId}),{rejectQuery:true,json:true,feature:"receivable-collection-recover"});}
