import type { NextRequest } from "next/server";
import { compensationHttp } from "@/modules/finance/ui/compensation-http";
import { reviewEmployeePercentageRun } from "@/modules/finance/application/employee-percentage-workspace";
export const runtime="nodejs";
export async function POST(request:NextRequest){return compensationHttp(request,(actor,input,requestId)=>reviewEmployeePercentageRun(actor,input,{requestId}),{rejectQuery:true,json:true,maxBytes:3145728,feature:"employee-percentage-run-review"});}
