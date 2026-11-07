import type { NextRequest } from "next/server";
import { prisma } from "@/platform/db/client";
import { documentHttp } from "@/modules/documents/ui/document-http";
import { readDocumentExpiry } from "@/modules/documents/application/document-expiry-service";
export async function POST(request:NextRequest){return documentHttp(request,(actor,input,requestId)=>readDocumentExpiry(actor,input,{db:prisma,requestId}),{feature:"F-DOC-09"});}
