import type { NextRequest } from "next/server";
import { prisma } from "@/platform/db/client";
import { documentHttp } from "@/modules/documents/ui/document-http";
import { readDocumentSourceWorkspace } from "@/modules/documents/application/document-workspace";

export async function POST(request: NextRequest){return documentHttp(request,(actor,input,requestId)=>readDocumentSourceWorkspace(actor,input,{db:prisma,requestId}));}
