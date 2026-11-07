import type { NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/platform/db/client";
import { isSameOriginContentType } from "@/platform/http/same-origin";
import { readBoundedRequestBytes } from "@/platform/http/read-exact-response";
import { compensationHttp } from "@/modules/finance/ui/compensation-http";
import { configuredFinancialAttachmentObjects } from "@/modules/finance/application/financial-attachment-files";
import { uploadFinancialAttachmentPart } from "@/modules/finance/application/financial-attachment-parts";
import { financialAttachmentUploadChunkBytes,financialAttachmentPartReferenceSchema } from "@/modules/finance/domain/financial-attachment-parts";
import { FinancialAttachmentAccessError,FinancialAttachmentValidationError } from "@/modules/finance/domain/financial-attachment";
export async function POST(request:NextRequest){
  return compensationHttp(request,async(actor,_input,requestId)=>{
    if(!isSameOriginContentType(request,"application/octet-stream"))throw new FinancialAttachmentAccessError();
    if([...request.nextUrl.searchParams.keys()].sort().join(",")!=="id,index")throw new FinancialAttachmentValidationError();
    const input=financialAttachmentPartReferenceSchema.parse({id:request.nextUrl.searchParams.get("id"),index:Number(z.string().regex(/^(?:0|[1-9][0-9]?)$/u).parse(request.nextUrl.searchParams.get("index")))});let bytes:Uint8Array;
    try{bytes=await readBoundedRequestBytes(request,financialAttachmentUploadChunkBytes);}catch{throw new FinancialAttachmentValidationError();}
    return uploadFinancialAttachmentPart(actor,input,bytes,{db:prisma,requestId,objects:configuredFinancialAttachmentObjects()});
  },{feature:"F-FIN-38.part"});
}
