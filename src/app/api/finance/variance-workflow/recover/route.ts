import type { NextRequest } from "next/server";
import { prisma } from "@/platform/db/client";
import { compensationHttp } from "@/modules/finance/ui/compensation-http";
import { recoverVarianceWorkflow } from "@/modules/finance/application/variance-workflow-service";
import { authorizeVarianceSource } from "@/platform/reconciliation/variance-source-authority";
export async function POST(request: NextRequest) {
  return compensationHttp(request, async (actor, input, requestId) => {
    const result = await recoverVarianceWorkflow(actor, input, { db: prisma, authorizeSource: authorizeVarianceSource, requestId });
    return { request: result.receipt };
  }, { json: true, rejectQuery: true, feature: "F-FIN-33" });
}
