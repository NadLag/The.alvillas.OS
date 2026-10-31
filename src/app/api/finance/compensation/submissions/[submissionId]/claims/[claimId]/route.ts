import type { NextRequest } from "next/server";
import { getEmployeeCompensationClaimDetail } from "@/modules/finance/application/employee-compensation-claim-workspace";
import { compensationHttp } from "@/modules/finance/ui/compensation-http";
export const runtime="nodejs";
export async function GET(request:NextRequest,context:{params:Promise<{submissionId:string;claimId:string}>}){
  return compensationHttp(request,async actor=>{const params=await context.params;return getEmployeeCompensationClaimDetail(actor,{...Object.fromEntries(request.nextUrl.searchParams),id:params.submissionId,claimId:params.claimId});},{feature:"employee-compensation-claim-detail"});
}
