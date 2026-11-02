import type {NextRequest} from "next/server";
import {compensationHttp} from "@/modules/finance/ui/compensation-http";
import {listEmployeePercentageBases} from "@/modules/finance/application/employee-percentage-workspace";
export const runtime="nodejs";
export async function POST(request:NextRequest){return compensationHttp(request,(actor,input,requestId)=>listEmployeePercentageBases(actor,input,{requestId}),{rejectQuery:true,json:true,maxBytes:8192,feature:"employee-percentage-base-picker"});}
