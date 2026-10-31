import type { NextRequest } from "next/server";
import { compensationHttp } from "@/modules/finance/ui/compensation-http";
import { recoverEmployeeMonthlyRunRequest } from "@/modules/finance/application/employee-monthly-run-requests";
export const runtime="nodejs";
export async function POST(request:NextRequest){return compensationHttp(request,(actor,input,requestId)=>recoverEmployeeMonthlyRunRequest(actor,input,{requestId}),{rejectQuery:true,json:true,maxBytes:4096,feature:"employee-monthly-run-request-recovery"});}
