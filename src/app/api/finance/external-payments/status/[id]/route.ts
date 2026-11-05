import type { NextRequest } from "next/server";
import { compensationHttp } from "@/modules/finance/ui/compensation-http";
import { getExternalPaymentIntent } from "@/modules/finance/application/external-payment-workspace-service";
export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  return compensationHttp(request, (actor, _input, requestId) => getExternalPaymentIntent(actor, { id }, { requestId }), { rejectQuery: true, feature: "F-FIN-08" });
}
