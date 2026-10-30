import type { NextRequest } from "next/server";
import { z } from "zod";
import { getEmployeeCompensationRun } from "@/modules/finance/application/employee-compensation-run-service";
import { compensationHttp } from "@/modules/finance/ui/compensation-http";

export const runtime="nodejs";
export async function GET(request:NextRequest,{params}:{params:Promise<{runId:string}>}){
  return compensationHttp(request,async(actor,_input,requestId)=>{
    const {runId}=await params,query=z.object({after:z.uuid().optional()}).strict().parse(Object.fromEntries(request.nextUrl.searchParams));
    return getEmployeeCompensationRun(actor,{id:runId,...query},{requestId});
  },{feature:"employee-compensation-run-read"});
}
