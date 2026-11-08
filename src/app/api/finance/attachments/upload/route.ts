import type { NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/platform/db/client";
import { isSameOriginContentType } from "@/platform/http/same-origin";
import { readBoundedRequestBytes } from "@/platform/http/read-exact-response";
import { compensationHttp } from "@/modules/finance/ui/compensation-http";
import { uploadFinancialAttachment } from "@/modules/finance/application/financial-attachments";
import { configuredFinancialAttachmentObjects } from "@/modules/finance/application/financial-attachment-files";
import { FinancialAttachmentAccessError, FinancialAttachmentValidationError } from "@/modules/finance/domain/financial-attachment";
import { financialAttachmentSingleBodyBytes } from "@/modules/finance/domain/financial-attachment-parts";

export async function POST(request: NextRequest) {
  return compensationHttp(request, async (actor, _input, requestId) => {
    if (!isSameOriginContentType(request, "application/octet-stream")) throw new FinancialAttachmentAccessError();
    if ([...request.nextUrl.searchParams.keys()].join(",") !== "id") throw new FinancialAttachmentValidationError();
    const id = z.uuid().parse(request.nextUrl.searchParams.get("id")); let bytes: Uint8Array;
    try { bytes = await readBoundedRequestBytes(request, financialAttachmentSingleBodyBytes); } catch { throw new FinancialAttachmentValidationError(); }
    return uploadFinancialAttachment(actor, { id }, bytes, { db: prisma, requestId, objects: configuredFinancialAttachmentObjects() });
  }, { feature: "F-FIN-38.upload" });
}
