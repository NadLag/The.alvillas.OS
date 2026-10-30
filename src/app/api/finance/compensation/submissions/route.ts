import type { NextRequest } from "next/server";
import { requestEmployeeCompensationSubmission } from "@/modules/finance/application/employee-compensation-submission-requests";
import { compensationHttp } from "@/modules/finance/ui/compensation-http";

export const runtime="nodejs";
export async function POST(request:NextRequest){
  return compensationHttp(request,(actor,input,requestId)=>requestEmployeeCompensationSubmission(actor,input,{requestId}),{json:true,maxBytes:16*1024*1024,status:202,feature:"employee-compensation-submit"});
}
