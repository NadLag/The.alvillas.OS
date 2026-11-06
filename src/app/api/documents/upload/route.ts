import type { NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/platform/db/client";
import { readBoundedRequestBytes } from "@/platform/http/read-exact-response";
import { documentHttp } from "@/modules/documents/ui/document-http";
import { uploadDocumentBytes } from "@/modules/documents/application/document-archive";
import { configuredDocumentObjects } from "@/modules/documents/application/document-files";
import { documentSingleBodyBytes } from "@/modules/documents/domain/document-upload-parts";

export async function POST(request: NextRequest) {
  return documentHttp(request, async (actor,_input,requestId)=>{
    if ([...request.nextUrl.searchParams.keys()].join(",")!=="admissionId") throw new z.ZodError([]);
    const admissionId=z.uuid().parse(request.nextUrl.searchParams.get("admissionId"));let bytes:Uint8Array;
    try{bytes=await readBoundedRequestBytes(request,documentSingleBodyBytes);}catch{throw new z.ZodError([]);}
    return uploadDocumentBytes(actor,{admissionId},bytes,{db:prisma,requestId,objects:configuredDocumentObjects()});
  },{binary:true});
}
