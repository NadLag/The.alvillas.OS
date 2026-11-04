import type { NextRequest } from "next/server";
import { prisma } from "@/platform/db/client";
import { compensationHttp } from "@/modules/finance/ui/compensation-http";
import { downloadFinancialAttachment } from "@/modules/finance/application/financial-attachments";
import { configuredFinancialAttachmentObjects } from "@/modules/finance/application/financial-attachment-files";

export async function POST(request: NextRequest) {
  return compensationHttp(request, (actor, input, requestId) => downloadFinancialAttachment(actor, input,
    { db: prisma, requestId, objects: configuredFinancialAttachmentObjects() }), { json: true, rejectQuery: true, maxBytes: 16384, feature: "F-FIN-38.download",
    respond: file => new Response(new Uint8Array(file.bytes), { headers: { "Content-Type": file.contentType, "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "sandbox", "Content-Disposition": `attachment; filename="document.${file.contentType === "application/pdf" ? "pdf" : file.contentType.split("/")[1]}"; filename*=UTF-8''${encodeURIComponent(file.fileName).replace(/['()*]/gu, value => "%" + value.charCodeAt(0).toString(16).toUpperCase())}` } }) });
}
