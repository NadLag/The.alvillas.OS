import type { NextRequest } from "next/server";
import { compensationHttp } from "@/modules/finance/ui/compensation-http";
import { readBankReconciliationWorkspace } from "@/modules/finance/application/bank-reconciliation-service";
export async function POST(request: NextRequest) {
  return compensationHttp(request, (actor, input, requestId) => readBankReconciliationWorkspace(actor, input, { requestId }), { json: true, rejectQuery: true, feature: "F-FIN-31" });
}
