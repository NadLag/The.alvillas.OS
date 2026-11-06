import type { NextRequest } from "next/server";
import { prisma } from "@/platform/db/client";
import { documentHttp } from "@/modules/documents/ui/document-http";
import { readDocumentSources } from "@/modules/documents/application/document-workspace";

export async function POST(request: NextRequest){return documentHttp(request,(actor,input,requestId)=>readDocumentSources(actor,input,{db:prisma,requestId}));}
