import type { NextRequest } from "next/server";
import { compensationHttp } from "@/modules/finance/ui/compensation-http";
import { readBankStatementBody } from "@/modules/finance/ui/bank-statement-body";
import { reviewBankStatement } from "@/modules/finance/application/bank-statement-import";
export async function POST(request: NextRequest) {
  return compensationHttp(request, async (actor, _input, requestId) => {
    const source = await readBankStatementBody(request);
    return reviewBankStatement(actor, source.input, source.bytes, { requestId });
  }, { rejectQuery: true, feature: "F-FIN-31" });
}
