import type { NextRequest } from "next/server";
import { compensationHttp } from "@/modules/finance/ui/compensation-http";
import { voidEmployeeCompensationSettlement } from "@/modules/finance/application/employee-compensation-settlement";
export const runtime="nodejs";
export async function POST(request:NextRequest,context:{params:Promise<{paymentId:string}>}){return compensationHttp(request,async(actor,input,requestId)=>{const paymentId=(await context.params).paymentId;return voidEmployeeCompensationSettlement(actor,{...(input&&typeof input==="object"?input:{}),paymentId},{requestId});},{json:true,maxBytes:4096,feature:"employee-compensation-settlement-reversal"});}
