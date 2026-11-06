import type { NextRequest } from "next/server";
import { prisma } from "@/platform/db/client";
import { documentHttp } from "@/modules/documents/ui/document-http";
import { reviewDocumentTemplate } from "@/modules/documents/application/document-template-authoring";
import { documentTemplateMaximumBytes } from "@/modules/documents/domain/document-template-format";
export async function POST(request:NextRequest){return documentHttp(request,(actor,input,requestId)=>reviewDocumentTemplate(actor,input,{db:prisma,requestId}),{jsonBytes:documentTemplateMaximumBytes+16384,feature:"F-DOC-02"});}
