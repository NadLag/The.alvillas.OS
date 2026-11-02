import type {NextRequest} from "next/server";
import {compensationHttp} from "@/modules/finance/ui/compensation-http";
import {getEmployeeCompensationCorrectionRequest} from "@/modules/finance/application/employee-compensation-recognition-requests";
export const dynamic="force-dynamic";
export async function GET(request:NextRequest,context:{params:Promise<{requestId:string}>}){const{requestId}=await context.params;return compensationHttp(request,actor=>getEmployeeCompensationCorrectionRequest(actor,{id:requestId}),{rejectQuery:true,feature:"employee-compensation-correction-request"});}
