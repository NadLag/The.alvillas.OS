import type { NextRequest } from "next/server";
import { compensationHttp } from "@/modules/finance/ui/compensation-http";
import { getEmployeeMonthlyRunEditor } from "@/modules/finance/application/employee-monthly-workspace";
export const runtime="nodejs";
export async function GET(request:NextRequest){return compensationHttp(request,(actor,_input,requestId)=>getEmployeeMonthlyRunEditor(actor,{requestId}),{rejectQuery:true,feature:"employee-monthly-run-editor"});}
