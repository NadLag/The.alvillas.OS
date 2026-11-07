import type { NextRequest } from "next/server";
import { prisma } from "@/platform/db/client";
import { documentHttp } from "@/modules/documents/ui/document-http";
import { readSignaturePreparationTarget } from "@/modules/documents/application/document-signature-preparation";
export async function POST(request: NextRequest) { return documentHttp(request, (actor, input, requestId) => readSignaturePreparationTarget(actor, input, { db: prisma, requestId }), { feature: "F-DOC-06" }); }
