import type {NextRequest} from "next/server";
import {compensationHttp} from "@/modules/finance/ui/compensation-http";
import {listExpensePurchaseChoices} from "@/modules/finance/application/expense-purchase-choices";
export function POST(request:NextRequest){return compensationHttp(request,(actor,input,requestId)=>listExpensePurchaseChoices(actor,input,{requestId}),{json:true,maxBytes:2048,rejectQuery:true,feature:"expense-purchase-choices"});}
