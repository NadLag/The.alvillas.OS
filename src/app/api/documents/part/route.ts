import type { NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/platform/db/client";
import { readBoundedRequestBytes } from "@/platform/http/read-exact-response";
import { documentHttp } from "@/modules/documents/ui/document-http";
import { uploadDocumentPart } from "@/modules/documents/application/document-archive";
import { configuredDocumentObjects } from "@/modules/documents/application/document-files";
import { documentUploadChunkBytes } from "@/modules/documents/domain/document-upload-parts";

export async function POST(request:NextRequest){return documentHttp(request,async(actor,_input,requestId)=>{
  if([...request.nextUrl.searchParams.keys()].sort().join(",")!=="admissionId,index")throw new z.ZodError([]);
  const admissionId=z.uuid().parse(request.nextUrl.searchParams.get("admissionId")),index=Number(z.string().regex(/^(?:0|[1-9]\d*)$/u).parse(request.nextUrl.searchParams.get("index")));let bytes:Uint8Array;
  try{bytes=await readBoundedRequestBytes(request,documentUploadChunkBytes);}catch{throw new z.ZodError([]);}
  return uploadDocumentPart(actor,{admissionId,index},bytes,{db:prisma,requestId,objects:configuredDocumentObjects()});
},{binary:true});}
