import type { NextRequest } from "next/server";
import { prisma } from "@/platform/db/client";
import { documentHttp } from "@/modules/documents/ui/document-http";
import { searchDocuments } from "@/modules/documents/application/document-search-service";
export async function POST(request:NextRequest){return documentHttp(request,(actor,input,requestId)=>searchDocuments(actor,input,{db:prisma,requestId}),{feature:"F-DOC-11"});}
