import type { NextRequest } from "next/server";
import { prisma } from "@/platform/db/client";
import { compensationHttp } from "@/modules/finance/ui/compensation-http";
import { readPaymentMethodCatalog } from "@/modules/finance/application/payment-method-service";

export async function POST(request: NextRequest) {
  return compensationHttp(request, (actor, input, requestId) => readPaymentMethodCatalog(actor, input, { db: prisma, requestId }),
    { json: true, rejectQuery: true, maxBytes: 4096, feature: "F-FIN-08.method_editor" });
}
