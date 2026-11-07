import type { NextRequest } from "next/server";
import { prisma } from "@/platform/db/client";
import { documentHttp } from "@/modules/documents/ui/document-http";
import { reconcileSignatureDistribution } from "@/modules/documents/application/document-signature-reconciliation";
export async function POST(request: NextRequest) { return documentHttp(request, (actor, input, requestId) => reconcileSignatureDistribution(actor, input, { db: prisma, requestId }), { feature: "F-DOC-06" }); }
