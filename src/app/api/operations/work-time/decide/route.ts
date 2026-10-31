import type { NextRequest } from "next/server";
import { compensationHttp } from "@/modules/finance/ui/compensation-http";
import { decideEmployeeWorkTime } from "@/modules/finance/application/employee-work-time-service";
export const runtime="nodejs";
export async function POST(request:NextRequest){return compensationHttp(request,(actor,input,requestId)=>decideEmployeeWorkTime(actor,input,{requestId}),{json:true,maxBytes:8192,rejectQuery:true,feature:"employee-work-time-decide"});}
