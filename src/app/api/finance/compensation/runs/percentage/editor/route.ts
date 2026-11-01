import type { NextRequest } from "next/server";
import { compensationHttp } from "@/modules/finance/ui/compensation-http";
import { getEmployeePercentageRunEditor } from "@/modules/finance/application/employee-percentage-workspace";
export const runtime="nodejs";
export async function GET(request:NextRequest){return compensationHttp(request,(actor,_input,requestId)=>getEmployeePercentageRunEditor(actor,{requestId}),{rejectQuery:true,feature:"employee-percentage-run-editor"});}
