import type {NextRequest} from "next/server";
import {compensationHttp} from "@/modules/finance/ui/compensation-http";
import {getCompanyExpenseSettings,saveCompanyExpenseSettings} from "@/modules/finance/application/company-expense-settings-service";
export async function GET(request:NextRequest){return compensationHttp(request,actor=>getCompanyExpenseSettings(actor),{rejectQuery:true,feature:"F-FIN-27"});}
export async function POST(request:NextRequest){return compensationHttp(request,(actor,input,requestId)=>saveCompanyExpenseSettings(actor,input,{requestId}),{json:true,rejectQuery:true,maxBytes:65536,feature:"F-FIN-27"});}
