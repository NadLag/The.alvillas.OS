import type { NextRequest } from "next/server";
import { recoverEmployeeCompensationRun } from "@/modules/finance/application/employee-compensation-run-recovery";
import { compensationHttp } from "@/modules/finance/ui/compensation-http";
export const runtime="nodejs";
export async function POST(request:NextRequest){
  return compensationHttp(request,(actor,input,requestId)=>recoverEmployeeCompensationRun(actor,input,{requestId}),{json:true,maxBytes:1024,feature:"employee-compensation-run-recovery"});
}
