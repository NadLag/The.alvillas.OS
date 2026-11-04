import type { NextRequest } from "next/server";
import { prisma } from "@/platform/db/client";
import { compensationHttp } from "@/modules/finance/ui/compensation-http";
import { readVarianceWorkflowHistory } from "@/modules/finance/application/variance-workflow-service";
import { authorizeVarianceSource } from "@/platform/reconciliation/variance-source-authority";
export async function POST(request: NextRequest) {
  return compensationHttp(request, (actor, input, requestId) => readVarianceWorkflowHistory(actor, input, { db: prisma, authorizeSource: authorizeVarianceSource, requestId }), { json: true, rejectQuery: true, feature: "F-FIN-33" });
}
