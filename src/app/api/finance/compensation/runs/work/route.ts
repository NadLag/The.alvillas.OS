import type { NextRequest } from "next/server";
import { listEmployeeCompensationWork } from "@/modules/finance/application/employee-compensation-picker";
import { compensationHttp } from "@/modules/finance/ui/compensation-http";
export const runtime="nodejs";
export async function GET(request:NextRequest){
  return compensationHttp(request,(actor,_input,requestId)=>listEmployeeCompensationWork(actor,Object.fromEntries(request.nextUrl.searchParams),{requestId}),{feature:"employee-compensation-run-work"});
}
