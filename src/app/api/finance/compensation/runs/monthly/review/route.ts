import type { NextRequest } from "next/server";
import { compensationHttp } from "@/modules/finance/ui/compensation-http";
import { reviewEmployeeMonthlyRun } from "@/modules/finance/application/employee-monthly-workspace";
export const runtime="nodejs";
export async function POST(request:NextRequest){return compensationHttp(request,(actor,input,requestId)=>reviewEmployeeMonthlyRun(actor,input,{requestId}),{rejectQuery:true,json:true,maxBytes:65536,feature:"employee-monthly-run-review"});}
