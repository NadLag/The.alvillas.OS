import type { NextRequest } from "next/server";
import { previewEmployeeCompensationRequest } from "@/modules/finance/application/employee-compensation-preview-request";
import { compensationHttp } from "@/modules/finance/ui/compensation-http";

export const runtime = "nodejs";
export async function POST(request: NextRequest) {
  return compensationHttp(request,(actor,input,requestId)=>previewEmployeeCompensationRequest(actor,input,requestId),{json:true,feature:"employee-compensation-preview"});
}
