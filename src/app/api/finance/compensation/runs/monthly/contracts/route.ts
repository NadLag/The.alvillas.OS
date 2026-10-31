import type { NextRequest } from "next/server";
import { compensationHttp } from "@/modules/finance/ui/compensation-http";
import { listEmployeeMonthlyContracts } from "@/modules/finance/application/employee-monthly-workspace";
export const runtime="nodejs";
export async function POST(request:NextRequest){return compensationHttp(request,(actor,input,requestId)=>listEmployeeMonthlyContracts(actor,input,{requestId}),{rejectQuery:true,json:true,maxBytes:8192,feature:"employee-monthly-contract-picker"});}
