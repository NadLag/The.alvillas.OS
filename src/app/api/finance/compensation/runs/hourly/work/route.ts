import type { NextRequest } from "next/server";
import { compensationHttp } from "@/modules/finance/ui/compensation-http";
import { listEmployeeHourlyWork } from "@/modules/finance/application/employee-hourly-workspace";
export const runtime="nodejs";
export async function POST(request:NextRequest){return compensationHttp(request,(actor,input,requestId)=>listEmployeeHourlyWork(actor,input,{requestId}),{rejectQuery:true,json:true,maxBytes:8192,feature:"employee-hourly-contract-picker"});}
