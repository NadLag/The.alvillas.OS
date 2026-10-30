import type { NextRequest } from "next/server";
import { z } from "zod";
import { cancelEmployeeCompensationRun } from "@/modules/finance/application/employee-compensation-run-service";
import { compensationHttp } from "@/modules/finance/ui/compensation-http";

export const runtime="nodejs";
export async function POST(request:NextRequest,{params}:{params:Promise<{runId:string}>}){
  return compensationHttp(request,async(actor,input,requestId)=>{
    const {runId}=await params,value=z.object({reason:z.string()}).strict().parse(input);
    return cancelEmployeeCompensationRun(actor,{id:runId,...value},{requestId});
  },{json:true,feature:"employee-compensation-run-cancel"});
}
