import type { NextRequest } from "next/server";
import { compensationHttp } from "@/modules/finance/ui/compensation-http";
import { getEmployeeWorkTime } from "@/modules/finance/application/employee-work-time-service";
export const runtime="nodejs";
export async function POST(request:NextRequest){return compensationHttp(request,(actor,input,requestId)=>getEmployeeWorkTime(actor,input,{requestId}),{json:true,maxBytes:4096,rejectQuery:true,feature:"employee-work-time-read"});}
