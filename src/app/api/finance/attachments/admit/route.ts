import type { NextRequest } from "next/server";
import { prisma } from "@/platform/db/client";
import { compensationHttp } from "@/modules/finance/ui/compensation-http";
import { admitFinancialAttachment } from "@/modules/finance/application/financial-attachments";

export async function POST(request: NextRequest) {
  return compensationHttp(request, (actor, input, requestId) => admitFinancialAttachment(actor, input, { db: prisma, requestId }),
    { json: true, rejectQuery: true, maxBytes: 16384, feature: "F-FIN-38.admit" });
}
