import type { NextRequest } from "next/server";
import { compensationHttp } from "@/modules/finance/ui/compensation-http";
import { reviewEmployeeHourlyRun } from "@/modules/finance/application/employee-hourly-workspace";
export const runtime="nodejs";
export async function POST(request:NextRequest){return compensationHttp(request,(actor,input,requestId)=>reviewEmployeeHourlyRun(actor,input,{requestId}),{rejectQuery:true,json:true,maxBytes:3145728,feature:"employee-hourly-run-review"});}
