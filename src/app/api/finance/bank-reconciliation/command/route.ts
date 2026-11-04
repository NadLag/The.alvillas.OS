import type { NextRequest } from "next/server";
import { compensationHttp } from "@/modules/finance/ui/compensation-http";
import { requestBankReconciliationCommand } from "@/modules/finance/application/bank-reconciliation-command";
export async function POST(request: NextRequest) {
  return compensationHttp(request, (actor, input, requestId) => requestBankReconciliationCommand(actor, input, { requestId }), { json: true, maxBytes: 128 * 1024, rejectQuery: true, feature: "F-FIN-31" });
}
