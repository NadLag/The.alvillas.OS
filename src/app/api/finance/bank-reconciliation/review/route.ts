import type { NextRequest } from "next/server";
import { compensationHttp } from "@/modules/finance/ui/compensation-http";
import { reviewBankReconciliation } from "@/modules/finance/application/bank-reconciliation-service";
export async function POST(request: NextRequest) {
  return compensationHttp(request, (actor, input, requestId) => reviewBankReconciliation(actor, input, { requestId }), { json: true, maxBytes: 128 * 1024, rejectQuery: true, feature: "F-FIN-31" });
}
