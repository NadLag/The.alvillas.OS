import type { NextRequest } from "next/server";
import { prisma } from "@/platform/db/client";
import { documentHttp } from "@/modules/documents/ui/document-http";
import { admitSignatureDistribution } from "@/modules/documents/application/document-signature-distribution";
export async function POST(request: NextRequest) { return documentHttp(request, (actor, input, requestId) => admitSignatureDistribution(actor, input, { db: prisma, requestId }), { feature: "F-DOC-06" }); }
