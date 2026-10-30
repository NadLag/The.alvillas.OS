import type { NextRequest } from "next/server";
import { z } from "zod";
import { getEmployeeCompensationRunEditor } from "@/modules/finance/application/employee-compensation-picker";
import { compensationHttp } from "@/modules/finance/ui/compensation-http";
export const runtime="nodejs";
export async function GET(request:NextRequest){
  return compensationHttp(request,(actor,_input,requestId)=>{
    z.object({}).strict().parse(Object.fromEntries(request.nextUrl.searchParams));return getEmployeeCompensationRunEditor(actor,{requestId});
  },{feature:"employee-compensation-run-editor"});
}
