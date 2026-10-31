import type { NextRequest } from "next/server";
import { compensationHttp } from "@/modules/finance/ui/compensation-http";
import { recoverEmployeeCompensationSettlement } from "@/modules/finance/application/employee-compensation-settlement";
export const runtime="nodejs";
export async function POST(request:NextRequest){return compensationHttp(request,(actor,input)=>recoverEmployeeCompensationSettlement(actor,input),{json:true,maxBytes:4096,feature:"employee-compensation-settlement-recovery"});}
