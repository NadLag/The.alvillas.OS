import type { NextRequest } from "next/server";
import { prisma } from "@/platform/db/client";
import { documentHttp } from "@/modules/documents/ui/document-http";
import { reviewSignatureIdentityRecovery } from "@/modules/documents/application/document-signature-identity-recovery";
export async function POST(request: NextRequest) { return documentHttp(request, (actor, input, requestId) => reviewSignatureIdentityRecovery(actor, input, { db: prisma, requestId }), { feature: "F-DOC-06" }); }
