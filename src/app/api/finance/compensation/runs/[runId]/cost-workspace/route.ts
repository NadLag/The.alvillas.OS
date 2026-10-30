import type { NextRequest } from "next/server";
import { z } from "zod";
import { getEmployeeCompensationCostWorkspace } from "@/modules/finance/application/employee-compensation-cost-workspace";
import { compensationHttp } from "@/modules/finance/ui/compensation-http";
export const runtime="nodejs";
export async function GET(request:NextRequest,context:{params:Promise<{runId:string}>}){
  return compensationHttp(request,async actor=>{const query=z.object({after:z.string().optional()}).strict().parse(Object.fromEntries(request.nextUrl.searchParams));return getEmployeeCompensationCostWorkspace(actor,{...query,runId:(await context.params).runId});},{feature:"employee-compensation-cost-workspace"});
}
