import type { NextRequest } from "next/server";
import { compensationHttp } from "@/modules/finance/ui/compensation-http";
import { getEmployeeCompensationRecognitionRequest } from "@/modules/finance/application/employee-compensation-recognition-requests";
export const dynamic="force-dynamic";
export async function GET(request:NextRequest,context:{params:Promise<{requestId:string}>}){const{requestId}=await context.params;return compensationHttp(request,actor=>getEmployeeCompensationRecognitionRequest(actor,{id:requestId}),{feature:"employee-compensation-recognition-request"});}
