import type { NextRequest } from "next/server";
import { z } from "zod";
import { compensationHttp } from "@/modules/finance/ui/compensation-http";
import { getEmployeeCompensationPaymentWorkspace } from "@/modules/finance/application/employee-compensation-payment-workspace";
export const runtime="nodejs";
export async function POST(request:NextRequest,context:{params:Promise<{submissionId:string;claimId:string}>}){return compensationHttp(request,async(actor,input,requestId)=>{const params=await context.params;return getEmployeeCompensationPaymentWorkspace(actor,{...z.record(z.string(),z.unknown()).parse(input),id:params.submissionId,claimId:params.claimId},{requestId});},{json:true,maxBytes:8192,feature:"employee-compensation-payment-workspace"});}
