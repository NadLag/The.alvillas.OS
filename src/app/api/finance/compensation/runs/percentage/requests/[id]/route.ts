import type { NextRequest } from "next/server";
import { compensationHttp } from "@/modules/finance/ui/compensation-http";
import { getEmployeeEarningRunRequest } from "@/modules/finance/application/employee-earning-run-requests";
export const runtime="nodejs";
export async function GET(request:NextRequest,context:{params:Promise<{id:string}>}){return compensationHttp(request,async(actor,_input,requestId)=>getEmployeeEarningRunRequest(actor,{id:(await context.params).id},{requestId}),{rejectQuery:true,feature:"employee-percentage-run-request-status"});}
