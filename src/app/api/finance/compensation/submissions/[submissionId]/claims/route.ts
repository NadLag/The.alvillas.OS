import type { NextRequest } from "next/server";
import { getEmployeeCompensationClaimWorkspace } from "@/modules/finance/application/employee-compensation-claim-workspace";
import { compensationHttp } from "@/modules/finance/ui/compensation-http";
export const runtime="nodejs";
export async function GET(request:NextRequest,context:{params:Promise<{submissionId:string}>}){
  return compensationHttp(request,async actor=>getEmployeeCompensationClaimWorkspace(actor,{...Object.fromEntries(request.nextUrl.searchParams),id:(await context.params).submissionId}),{feature:"employee-compensation-claims"});
}
