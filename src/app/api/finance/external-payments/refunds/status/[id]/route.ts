import type { NextRequest } from "next/server";
import { compensationHttp } from "@/modules/finance/ui/compensation-http";
import { getExternalPaymentRefund } from "@/modules/finance/application/external-payment-refund-workspace-service";
export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  return compensationHttp(request, (actor, _input, requestId) => getExternalPaymentRefund(actor, { intentId: id }, { requestId }), { rejectQuery: true, feature: "F-FIN-30" });
}
