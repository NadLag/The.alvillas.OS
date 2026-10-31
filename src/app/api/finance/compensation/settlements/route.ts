import type { NextRequest } from "next/server";
import { compensationHttp } from "@/modules/finance/ui/compensation-http";
import { postEmployeeCompensationSettlement } from "@/modules/finance/application/employee-compensation-settlement";
export const runtime="nodejs";
export async function POST(request:NextRequest){return compensationHttp(request,(actor,input,requestId)=>postEmployeeCompensationSettlement(actor,input,{requestId}),{json:true,maxBytes:8192,feature:"employee-compensation-settlement"});}
