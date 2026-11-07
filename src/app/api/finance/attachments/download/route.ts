import type { NextRequest } from "next/server";
import { prisma } from "@/platform/db/client";
import { compensationHttp } from "@/modules/finance/ui/compensation-http";
import { downloadFinancialAttachment } from "@/modules/finance/application/financial-attachments";
import { configuredFinancialAttachmentObjects } from "@/modules/finance/application/financial-attachment-files";
import { financialAttachmentUploadChunkBytes } from "@/modules/finance/domain/financial-attachment-parts";

export async function POST(request: NextRequest) {
  return compensationHttp(request, (actor, input, requestId) => downloadFinancialAttachment(actor, input,
    { db: prisma, requestId, objects: configuredFinancialAttachmentObjects() }), { json: true, rejectQuery: true, maxBytes: 16384, feature: "F-FIN-38.download",
    respond: file => {let offset=0;return new Response(new ReadableStream<Uint8Array>({pull(controller){if(offset>=file.bytes.length){controller.close();return;}controller.enqueue(new Uint8Array(file.bytes.subarray(offset,offset+financialAttachmentUploadChunkBytes)));offset+=financialAttachmentUploadChunkBytes;}}), { headers: { "Content-Type": file.contentType, "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "sandbox", "Content-Disposition": `attachment; filename="document.${file.contentType === "application/pdf" ? "pdf" : file.contentType.split("/")[1]}"; filename*=UTF-8''${encodeURIComponent(file.fileName).replace(/['()*]/gu, value => "%" + value.charCodeAt(0).toString(16).toUpperCase())}` } });} });
}
