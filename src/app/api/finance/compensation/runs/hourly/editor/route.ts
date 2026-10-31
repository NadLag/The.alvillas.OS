import type { NextRequest } from "next/server";
import { compensationHttp } from "@/modules/finance/ui/compensation-http";
import { getEmployeeHourlyRunEditor } from "@/modules/finance/application/employee-hourly-workspace";
export const runtime="nodejs";
export async function GET(request:NextRequest){return compensationHttp(request,(actor,_input,requestId)=>getEmployeeHourlyRunEditor(actor,{requestId}),{rejectQuery:true,feature:"employee-hourly-run-editor"});}
