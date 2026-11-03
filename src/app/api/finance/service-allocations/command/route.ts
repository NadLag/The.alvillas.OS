import type {NextRequest} from "next/server";
import {compensationHttp} from "@/modules/finance/ui/compensation-http";
import {requestServiceAllocationCommand} from "@/modules/finance/application/service-allocation-command-service";
export async function POST(request:NextRequest){return compensationHttp(request,(actor,input,requestId)=>requestServiceAllocationCommand(actor,input,{requestId}),{json:true,rejectQuery:true,feature:"F-FIN-29"});}
