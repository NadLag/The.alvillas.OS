import type {NextRequest} from "next/server";
import {compensationHttp} from "@/modules/finance/ui/compensation-http";
import {recoverGuestDepositCommandReceipt} from "@/modules/finance/application/guest-deposit-command-service";
export async function POST(request:NextRequest){return compensationHttp(request,(actor,input,requestId)=>recoverGuestDepositCommandReceipt(actor,input,{requestId}),{json:true,rejectQuery:true,feature:"F-FIN-30"});}
