import type { NextRequest } from "next/server";
import { prisma } from "@/platform/db/client";
import { compensationHttp } from "@/modules/finance/ui/compensation-http";
import { readAccountantExportEditor } from "@/modules/finance/application/accountant-export-service";

export async function POST(request: NextRequest) {
  return compensationHttp(request, (actor, input, requestId) => readAccountantExportEditor(actor, input, { db: prisma, requestId }),
    { json: true, rejectQuery: true, maxBytes: 16384, feature: "F-FIN-37.editor" });
}
