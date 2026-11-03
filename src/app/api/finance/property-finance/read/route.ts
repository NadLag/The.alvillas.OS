import type {NextRequest} from "next/server";
import {compensationHttp} from "@/modules/finance/ui/compensation-http";
import {getPropertyFinance} from "@/modules/finance/application/property-finance-service";
export async function POST(request:NextRequest){return compensationHttp(request,(actor,input,requestId)=>getPropertyFinance(actor,input,{requestId}),{json:true,rejectQuery:true,feature:"F-FIN-28"});}
