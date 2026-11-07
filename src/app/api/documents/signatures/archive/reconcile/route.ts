import type { NextRequest } from "next/server";
import { prisma } from "@/platform/db/client";
import { documentHttp } from "@/modules/documents/ui/document-http";
import { reconcileSignedArchive } from "@/modules/documents/application/document-signed-archive-reconciliation";
export async function POST(request: NextRequest) { return documentHttp(request, (actor, input, requestId) => reconcileSignedArchive(actor, input, { db: prisma, requestId }), { feature: "F-DOC-07" }); }
