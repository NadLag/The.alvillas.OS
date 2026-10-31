import type { NextRequest } from "next/server";
import { listPaymentAccountChoices } from "@/modules/finance/application/payment-account-choices";
import { compensationHttp } from "@/modules/finance/ui/compensation-http";

export async function POST(request:NextRequest){
  return compensationHttp(request,(actor,input,requestId)=>listPaymentAccountChoices(actor,input,{requestId}),{json:true,maxBytes:2048,rejectQuery:true,feature:"financial-payment-account-choices"});
}
