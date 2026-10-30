import type { NextRequest } from "next/server";
import { createEmployeeCompensationRun } from "@/modules/finance/application/employee-compensation-run-service";
import { compensationHttp } from "@/modules/finance/ui/compensation-http";

export const runtime="nodejs";
export async function POST(request:NextRequest){
  return compensationHttp(request,(actor,input,requestId)=>createEmployeeCompensationRun(actor,input,{requestId}),{json:true,maxBytes:2*1024*1024,feature:"employee-compensation-run-create"});
}
