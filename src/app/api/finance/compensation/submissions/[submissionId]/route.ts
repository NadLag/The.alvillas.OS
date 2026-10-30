import type { NextRequest } from "next/server";
import { z } from "zod";
import { getEmployeeCompensationSubmission } from "@/modules/finance/application/employee-compensation-submission";
import { compensationHttp } from "@/modules/finance/ui/compensation-http";

export const runtime="nodejs";
export async function GET(request:NextRequest,context:{params:Promise<{submissionId:string}>}){
  return compensationHttp(request,async actor=>{const query=z.object({after:z.uuid().optional()}).strict().parse(Object.fromEntries(request.nextUrl.searchParams));return getEmployeeCompensationSubmission(actor,{...query,id:(await context.params).submissionId});},{feature:"employee-compensation-submission-detail"});
}
