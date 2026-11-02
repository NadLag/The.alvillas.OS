import type { NextRequest } from "next/server";
import { compensationHttp } from "@/modules/finance/ui/compensation-http";
import { requestEmployeePercentageRun } from "@/modules/finance/application/employee-earning-run-requests";
export const runtime="nodejs";
export async function POST(request:NextRequest){return compensationHttp(request,(actor,input,requestId)=>requestEmployeePercentageRun(actor,input,{requestId}),{rejectQuery:true,json:true,maxBytes:3145728,feature:"employee-percentage-run-request",status:202});}
