import type { NextRequest } from "next/server";
import { z } from "zod";
import { getEmployeeCompensationCostDetail } from "@/modules/finance/application/employee-compensation-cost-detail";
import { compensationHttp } from "@/modules/finance/ui/compensation-http";

export const runtime="nodejs";
export async function GET(request:NextRequest,context:{params:Promise<{submissionId:string}>}){
  return compensationHttp(request,async actor=>{const query=z.object({after:z.uuid().optional()}).strict().parse(Object.fromEntries(request.nextUrl.searchParams));return getEmployeeCompensationCostDetail(actor,{...query,id:(await context.params).submissionId});},{feature:"employee-compensation-cost-detail"});
}
