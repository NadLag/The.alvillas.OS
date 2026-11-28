import { NextResponse, type NextRequest } from "next/server";
import { prisma } from "@/platform/db/client";
import { admitGuestHubLinkDelivery, reviewGuestHubLinkDelivery } from "@/modules/guest-hub/application/guest-hub-link-delivery";
import { guestHubPrivateHeaders, guestHubStaffHttp } from "@/modules/guest-hub/ui/guest-hub-http";

export async function POST(request: NextRequest, { params }: { params: Promise<{ operation: string }> }) {
  const { operation } = await params;
  if (operation !== "review" && operation !== "admit") {
    return NextResponse.json({ error: "not_found" }, { status: 404, headers: guestHubPrivateHeaders });
  }
  const action = operation === "review" ? reviewGuestHubLinkDelivery : admitGuestHubLinkDelivery;
  return guestHubStaffHttp(request, (actor, input, requestId) => action(actor, input, { db: prisma, requestId }));
}
