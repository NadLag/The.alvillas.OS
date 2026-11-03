import type {NextRequest} from "next/server";
import {compensationHttp} from "@/modules/finance/ui/compensation-http";
import {readServiceAllocationWorkspace} from "@/modules/finance/application/service-allocation-workspace-service";
export async function POST(request:NextRequest){return compensationHttp(request,(actor,input,requestId)=>readServiceAllocationWorkspace(actor,input,{requestId}),{json:true,rejectQuery:true,feature:"F-FIN-29"});}
