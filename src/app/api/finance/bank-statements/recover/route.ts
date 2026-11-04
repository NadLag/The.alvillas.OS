import type { NextRequest } from "next/server";
import { compensationHttp } from "@/modules/finance/ui/compensation-http";
import { recoverBankStatementCommand } from "@/modules/finance/application/bank-statement-command";
export async function POST(request: NextRequest) {
  return compensationHttp(request, (actor, input, requestId) => recoverBankStatementCommand(actor, input, { requestId }), { json: true, rejectQuery: true, feature: "F-FIN-31" });
}
