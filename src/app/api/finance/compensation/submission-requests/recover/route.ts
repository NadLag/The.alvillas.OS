import type { NextRequest } from "next/server";
import { recoverEmployeeCompensationSubmissionRequest } from "@/modules/finance/application/employee-compensation-submission-requests";
import { compensationHttp } from "@/modules/finance/ui/compensation-http";
export const runtime="nodejs";
export async function POST(request:NextRequest){return compensationHttp(request,(actor,input)=>recoverEmployeeCompensationSubmissionRequest(actor,input),{json:true,maxBytes:1024,feature:"employee-compensation-submission-recovery"});}
