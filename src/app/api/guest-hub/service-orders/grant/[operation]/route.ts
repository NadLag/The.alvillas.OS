import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/platform/db/client";
import { guestHubServiceOrderGrants } from "@/modules/guest-hub/application/guest-hub-service-order-grants";
import { guestHubPrivateHeaders, guestHubStaffHttp } from "@/modules/guest-hub/ui/guest-hub-http";

const operationSchema = z.enum(["status", "review", "admit", "recover"]);
const operations = { ...guestHubServiceOrderGrants, admit: guestHubServiceOrderGrants.record };

export async function POST(request: NextRequest, { params }: { params: Promise<{ operation: string }> }) {
  const operation = operationSchema.safeParse((await params).operation);
  if (!operation.success) return NextResponse.json({ error: "not_found" }, { status: 404, headers: guestHubPrivateHeaders });
  return guestHubStaffHttp(request, (actor, input, requestId) => operations[operation.data](actor, input, { db: prisma, requestId }));
}
