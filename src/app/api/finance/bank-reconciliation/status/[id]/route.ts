import type { NextRequest } from "next/server";
import { compensationHttp } from "@/modules/finance/ui/compensation-http";
import { bankReconciliationCommandStatus } from "@/modules/finance/application/bank-reconciliation-command";
export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const input = await context.params;
  return compensationHttp(request, (actor, _value, requestId) => bankReconciliationCommandStatus(actor, input, { requestId }), { rejectQuery: true, feature: "F-FIN-31" });
}
