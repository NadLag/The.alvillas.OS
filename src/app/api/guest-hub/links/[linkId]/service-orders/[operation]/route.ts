import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/platform/db/client";
import { listGuestHubServiceOffers } from "@/modules/guest-hub/application/guest-hub-service-order-offers";
import { recoverGuestHubServiceOrder, reviewGuestHubServiceOrder, submitGuestHubServiceOrder } from "@/modules/guest-hub/application/guest-hub-service-orders";
import { guestHubFormPublicHeaders, guestHubFormPublicHttp } from "@/modules/guest-hub/ui/guest-hub-form-public-http";
import { ServiceOrderConflictError, ServiceOrderValidationError } from "@/modules/services/domain/service-order";
import { GuestHubServiceOrderConflictError } from "@/modules/guest-hub/domain/guest-hub-service-order-policy";

const operationSchema = z.enum(["view", "review", "admit", "recover"]);
const definition = { feature: "F-GST-08" as const, viewPage: listGuestHubServiceOffers, review: reviewGuestHubServiceOrder,
  async admit(capability: unknown, input: unknown, deps: Parameters<typeof submitGuestHubServiceOrder>[2]) {
    try { return await submitGuestHubServiceOrder(capability, input, deps); }
    catch (error) { if (error instanceof ServiceOrderConflictError) throw new GuestHubServiceOrderConflictError(); throw error; }
  },
  recover: recoverGuestHubServiceOrder,
  validation: (error: unknown) => error instanceof ServiceOrderValidationError ? { error: "validation" } : null
};

export async function POST(request: NextRequest, { params }: { params: Promise<{ linkId: string; operation: string }> }) {
  const { linkId, operation } = await params;
  const action = operationSchema.safeParse(operation);
  if (!action.success) return NextResponse.json({ error: "not_found" }, { status: 404, headers: guestHubFormPublicHeaders });
  return guestHubFormPublicHttp(request, { db: prisma }, linkId, action.data, definition);
}
