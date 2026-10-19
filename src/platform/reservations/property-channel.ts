import type { TenantTransaction } from "@/platform/db/tenant";
import type { CoreActorContext } from "@/modules/core/application/core-access";
import { upsertPropertyBookingChannel } from "@/modules/core/application/core-service";
import { CoreRepository } from "@/modules/core/infrastructure/core-repository";

export function recordPropertyReservationSync(tx: TenantTransaction, organizationId: string, channelId: string, at: Date, status: string) {
  return new CoreRepository(tx, organizationId).recordBookingChannelSync(channelId, at, status);
}

/** Reservation feeds use the property channel's existing encrypted endpoint. */
export async function connectPropertyReservationChannel(tx: TenantTransaction, ctx: CoreActorContext, input: { propertyId: string; source: string; name: string; url: string }, metadata: { requestId: string; ipAddress: string | null }) {
  const current = await new CoreRepository(tx, ctx.organizationId).findBookingChannel(input.propertyId, input.source);
  return upsertPropertyBookingChannel(ctx, { propertyId: input.propertyId, sourceKey: input.source, displayName: current?.displayName ?? input.name,
    externalListingId: current?.externalListingId ?? undefined, listingUrl: current?.listingUrl ?? undefined,
    exportEnabled: current?.exportEnabled ?? false, importEnabled: true, syncMode: "ICAL", syncEndpointUrl: input.url, status: "ACTIVE"
  }, { db: { $transaction: work => work(tx) }, ...metadata });
}
