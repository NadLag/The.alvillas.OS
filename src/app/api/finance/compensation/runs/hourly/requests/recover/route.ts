import type { NextRequest } from "next/server";
import { compensationHttp } from "@/modules/finance/ui/compensation-http";
import { recoverEmployeeEarningRunRequest } from "@/modules/finance/application/employee-earning-run-requests";
export const runtime="nodejs";
export async function POST(request:NextRequest){return compensationHttp(request,(actor,input,requestId)=>recoverEmployeeEarningRunRequest(actor,input,{requestId}),{rejectQuery:true,json:true,maxBytes:4096,feature:"employee-hourly-run-request-recovery"});}
