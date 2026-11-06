import type { NextRequest } from "next/server";
import { prisma } from "@/platform/db/client";
import { documentHttp } from "@/modules/documents/ui/document-http";
import { completeDocumentParts } from "@/modules/documents/application/document-archive";
import { configuredDocumentObjects } from "@/modules/documents/application/document-files";

export async function POST(request:NextRequest){return documentHttp(request,(actor,input,requestId)=>completeDocumentParts(actor,input,{db:prisma,requestId,objects:configuredDocumentObjects()}));}
