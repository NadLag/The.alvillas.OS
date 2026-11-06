import type { NextRequest } from "next/server";
import { prisma } from "@/platform/db/client";
import { documentHttp } from "@/modules/documents/ui/document-http";
import { reviewDocumentGeneration } from "@/modules/documents/application/document-generation-review";
export async function POST(request:NextRequest){return documentHttp(request,(actor,input,requestId)=>reviewDocumentGeneration(actor,input,{db:prisma,requestId}),{feature:"F-DOC-03"});}
