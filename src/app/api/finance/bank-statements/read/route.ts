import type { NextRequest } from "next/server";
import { compensationHttp } from "@/modules/finance/ui/compensation-http";
import { readBankStatementWorkspace } from "@/modules/finance/application/bank-statement-workspace";
export async function POST(request: NextRequest) {
  return compensationHttp(request, (actor, input, requestId) => readBankStatementWorkspace(actor, input, { requestId }), { json: true, rejectQuery: true, feature: "F-FIN-31" });
}
