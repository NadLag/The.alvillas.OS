import type { NextRequest } from "next/server";
import { z } from "zod";
import { withdrawEmployeeCompensation } from "@/modules/finance/application/employee-compensation-submission";
import { compensationHttp } from "@/modules/finance/ui/compensation-http";

export const runtime="nodejs";
export async function POST(request:NextRequest,context:{params:Promise<{submissionId:string}>}){
  return compensationHttp(request,async(actor,raw,requestId)=>{const input=z.object({reason:z.string()}).strict().parse(raw);return withdrawEmployeeCompensation(actor,{id:(await context.params).submissionId,reason:input.reason},{requestId});},{json:true,maxBytes:4096,feature:"employee-compensation-withdraw"});
}
