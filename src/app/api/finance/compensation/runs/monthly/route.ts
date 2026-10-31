import type { NextRequest } from "next/server";
import { compensationHttp } from "@/modules/finance/ui/compensation-http";
import { createEmployeeMonthlyCompensationRun } from "@/modules/finance/application/employee-monthly-run-service";
export const runtime="nodejs";
export async function POST(request:NextRequest){return compensationHttp(request,(actor,input,requestId)=>createEmployeeMonthlyCompensationRun(actor,input,{requestId}),{json:true,maxBytes:65536,feature:"employee-monthly-compensation-run"});}
