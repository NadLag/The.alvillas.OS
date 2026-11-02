import type {NextRequest} from "next/server";
import {compensationHttp} from "@/modules/finance/ui/compensation-http";
import {recoverEmployeeCompensationCorrectionRequest} from "@/modules/finance/application/employee-compensation-recognition-requests";
export const dynamic="force-dynamic";
export async function POST(request:NextRequest){return compensationHttp(request,(actor,input)=>recoverEmployeeCompensationCorrectionRequest(actor,input),{json:true,maxBytes:4096,rejectQuery:true,feature:"employee-compensation-correction-recovery"});}
