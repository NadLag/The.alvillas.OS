import type { NextRequest } from "next/server";
import { prisma } from "@/platform/db/client";
import { documentHttp } from "@/modules/documents/ui/document-http";
import { publishDocumentGeneration } from "@/modules/documents/application/document-generation-publication";
import { configuredDocumentObjects } from "@/modules/documents/application/document-files";
export const runtime="nodejs";
export const maxDuration=300;
export async function POST(request:NextRequest){return documentHttp(request,(actor,input,requestId)=>publishDocumentGeneration(actor,input,{db:prisma,requestId,objects:configuredDocumentObjects()}),{feature:"F-DOC-03"});}
