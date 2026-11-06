import type { NextRequest } from "next/server";
import { prisma } from "@/platform/db/client";
import { documentHttp } from "@/modules/documents/ui/document-http";
import { recoverDocumentGeneration } from "@/modules/documents/application/document-generation-admission";
export async function POST(request:NextRequest){return documentHttp(request,(actor,input,requestId)=>recoverDocumentGeneration(actor,input,{db:prisma,requestId}),{feature:"F-DOC-03"});}
