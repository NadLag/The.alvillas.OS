import type { NextRequest } from "next/server";
import { getEmployeeCompensationSubmissionRequest } from "@/modules/finance/application/employee-compensation-submission-requests";
import { compensationHttp } from "@/modules/finance/ui/compensation-http";

export const runtime="nodejs";
export async function GET(request:NextRequest,context:{params:Promise<{requestId:string}>}){
  return compensationHttp(request,async actor=>getEmployeeCompensationSubmissionRequest(actor,{id:(await context.params).requestId}),{feature:"employee-compensation-submission-request"});
}
