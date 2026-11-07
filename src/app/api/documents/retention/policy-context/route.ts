import type { NextRequest } from "next/server";
import { prisma } from "@/platform/db/client";
import { documentHttp } from "@/modules/documents/ui/document-http";
import { readDocumentRetentionPolicyContext } from "@/modules/documents/application/document-retention-service";
export async function POST(request:NextRequest){return documentHttp(request,(actor,input,requestId)=>readDocumentRetentionPolicyContext(actor,input,{db:prisma,requestId}),{feature:"F-DOC-10"});}
