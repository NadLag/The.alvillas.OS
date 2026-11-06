import type { NextRequest } from "next/server";
import { prisma } from "@/platform/db/client";
import { documentHttp } from "@/modules/documents/ui/document-http";
import { reviewNativeSignature } from "@/modules/documents/application/document-signature-draft";
export async function POST(request: NextRequest) { return documentHttp(request, (actor, input, requestId) => reviewNativeSignature(actor, input, { db: prisma, requestId }), { feature: "F-DOC-06" }); }
