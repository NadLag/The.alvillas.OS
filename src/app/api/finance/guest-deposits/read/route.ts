import type {NextRequest} from "next/server";
import {compensationHttp} from "@/modules/finance/ui/compensation-http";
import {readGuestDepositWorkspace} from "@/modules/finance/application/guest-deposit-workspace-service";
export async function POST(request:NextRequest){return compensationHttp(request,(actor,input,requestId)=>readGuestDepositWorkspace(actor,input,{requestId}),{json:true,rejectQuery:true,feature:"F-FIN-30"});}
