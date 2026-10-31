import type { NextRequest } from "next/server";
import { getEmployeeCompensationNotice } from "@/modules/finance/application/employee-compensation-notice";
import { compensationHttp } from "@/modules/finance/ui/compensation-http";
export const dynamic="force-dynamic";
export async function GET(request:NextRequest,{params}:{params:Promise<{id:string}>}){
  return compensationHttp(request,async(actor,_input,requestId)=>getEmployeeCompensationNotice(actor,(await params).id,{requestId}),{feature:"employee_cost_owner_notice"});
}
