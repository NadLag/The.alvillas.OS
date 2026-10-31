import type { NextRequest } from "next/server";
import { compensationHttp } from "@/modules/finance/ui/compensation-http";
import { requestEmployeeHourlyRun } from "@/modules/finance/application/employee-earning-run-requests";
export const runtime="nodejs";
export async function POST(request:NextRequest){return compensationHttp(request,(actor,input,requestId)=>requestEmployeeHourlyRun(actor,input,{requestId}),{rejectQuery:true,json:true,maxBytes:3145728,feature:"employee-hourly-run-request",status:202});}
