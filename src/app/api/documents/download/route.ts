import type { NextRequest } from "next/server";
import { prisma } from "@/platform/db/client";
import { documentHttp } from "@/modules/documents/ui/document-http";
import { downloadDocumentVersion } from "@/modules/documents/application/document-archive";
import { configuredDocumentObjects } from "@/modules/documents/application/document-files";
import { documentUploadChunkBytes } from "@/modules/documents/domain/document-upload-parts";

export async function POST(request: NextRequest) {
  return documentHttp(request,(actor,input,requestId)=>downloadDocumentVersion(actor,input,{db:prisma,requestId,objects:configuredDocumentObjects()}),{
    respond:file=>{let offset=0;return new Response(new ReadableStream<Uint8Array>({pull(controller){if(offset>=file.bytes.length){controller.close();return;}controller.enqueue(new Uint8Array(file.bytes.subarray(offset,offset+documentUploadChunkBytes)));offset+=documentUploadChunkBytes;}}),{headers:{"Content-Type":file.contentType,"X-Content-Type-Options":"nosniff","Content-Security-Policy":"sandbox",
      "Content-Disposition":`attachment; filename="document"; filename*=UTF-8''${encodeURIComponent(file.fileName).replace(/['()*]/gu,value=>"%"+value.charCodeAt(0).toString(16).toUpperCase())}`}});}
  });
}
