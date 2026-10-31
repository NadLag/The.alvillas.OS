import type { NextRequest } from "next/server";
import { compensationHttp } from "@/modules/finance/ui/compensation-http";
import { recoverEmployeeCompensationRecognitionRequest } from "@/modules/finance/application/employee-compensation-recognition-requests";
export const dynamic="force-dynamic";
export async function POST(request:NextRequest){return compensationHttp(request,(actor,input)=>recoverEmployeeCompensationRecognitionRequest(actor,input),{json:true,maxBytes:4096,feature:"employee-compensation-recognition-recovery"});}
