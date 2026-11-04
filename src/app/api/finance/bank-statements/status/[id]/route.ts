import type { NextRequest } from "next/server";
import { compensationHttp } from "@/modules/finance/ui/compensation-http";
import { bankStatementCommandStatus } from "@/modules/finance/application/bank-statement-command";
export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const input = await context.params;
  return compensationHttp(request, (actor, _value, requestId) => bankStatementCommandStatus(actor, input, { requestId }), { rejectQuery: true, feature: "F-FIN-31" });
}
