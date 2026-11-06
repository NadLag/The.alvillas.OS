import type { NextRequest } from "next/server";
import { prisma } from "@/platform/db/client";
import { documentHttp } from "@/modules/documents/ui/document-http";
import { reviewDocumentUpload } from "@/modules/documents/application/document-archive";

export async function POST(request: NextRequest) { return documentHttp(request,(actor,input,requestId)=>reviewDocumentUpload(actor,input,{db:prisma,requestId})); }
