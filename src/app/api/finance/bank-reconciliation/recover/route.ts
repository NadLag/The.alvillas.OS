import type { NextRequest } from "next/server";
import { compensationHttp } from "@/modules/finance/ui/compensation-http";
import { recoverBankReconciliationCommand } from "@/modules/finance/application/bank-reconciliation-command";
export async function POST(request: NextRequest) {
  return compensationHttp(request, (actor, input, requestId) => recoverBankReconciliationCommand(actor, input, { requestId }), { json: true, rejectQuery: true, feature: "F-FIN-31" });
}
