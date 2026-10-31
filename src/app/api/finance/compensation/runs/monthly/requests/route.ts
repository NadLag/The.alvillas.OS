import type { NextRequest } from "next/server";
import { compensationHttp } from "@/modules/finance/ui/compensation-http";
import { requestEmployeeMonthlyRun } from "@/modules/finance/application/employee-monthly-run-requests";
export const runtime="nodejs";
export async function POST(request:NextRequest){return compensationHttp(request,(actor,input,requestId)=>requestEmployeeMonthlyRun(actor,input,{requestId}),{rejectQuery:true,json:true,maxBytes:65536,feature:"employee-monthly-run-request",status:202});}
