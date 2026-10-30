import type { NextRequest } from "next/server";
import { listEmployeeCompensationRuns } from "@/modules/finance/application/employee-compensation-run-list";
import { compensationHttp } from "@/modules/finance/ui/compensation-http";

export const runtime="nodejs";
export async function GET(request:NextRequest){
  return compensationHttp(request,(actor,_input,requestId)=>listEmployeeCompensationRuns(actor,Object.fromEntries(request.nextUrl.searchParams),{requestId}),{feature:"employee-compensation-run-list"});
}
