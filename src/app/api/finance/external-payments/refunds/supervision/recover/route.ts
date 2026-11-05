import type { NextRequest } from "next/server";
import { compensationHttp } from "@/modules/finance/ui/compensation-http";
import { recoverExternalRefundSupervisionReceipt } from "@/modules/finance/application/external-payment-refund-supervision-api-service";
export async function POST(request: NextRequest) { return compensationHttp(request, (actor, input, requestId) => recoverExternalRefundSupervisionReceipt(actor, input, { requestId }), { json: true, maxBytes: 4096, rejectQuery: true, feature: "F-FIN-30" }); }
