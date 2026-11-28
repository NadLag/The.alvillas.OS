import { z } from "zod";
import { configSlugSchema } from "@/platform/config/identifiers";
import { catalogFieldPolicy, present } from "@/platform/authz/present";
import { guestServiceOfferPageSchema } from "@/platform/services/guest-service-order-contracts";
import { GuestHubServiceOrderAccessError } from "../domain/guest-hub-service-order-policy";
import { GuestHubServiceOrderRepository } from "../infrastructure/guest-hub-service-order-repository";
import { withGuestHubForm } from "./guest-hub-form-visit";
import { activeGuestHubServiceOrder } from "./guest-hub-service-order-source";
import type { GuestHubVisitDependencies } from "./guest-hub-visit";

const pageInput = z.object({ after: configSlugSchema.optional() }).strict();
const offerPageSize = 20;

export function listGuestHubServiceOffers(capability: unknown, raw: unknown, deps: GuestHubVisitDependencies) {
  const { after } = pageInput.parse(raw);
  return withGuestHubForm(capability, deps, {
    resourceType: "guest_hub_service_orders", rateKey: "guest-hub:service-order:", active: activeGuestHubServiceOrder,
    lock: context => new GuestHubServiceOrderRepository(context.tx, context.actual.row.organizationId).lockLink(context.actual.row.id),
    AccessError: GuestHubServiceOrderAccessError
  }, ({ form, formAuthority, formResource }) => {
    const start = after ? form.offers.findIndex(offer => offer.key === after) + 1 : 0;
    if (after && start === 0) throw new GuestHubServiceOrderAccessError();
    const items = form.offers.slice(start, start + offerPageSize);
    const data = { items, next: start + items.length < form.offers.length ? items.at(-1)?.key ?? null : null };
    return Promise.resolve(guestServiceOfferPageSchema.parse(present({ ...formAuthority, visibleDataClasses: new Set() }, "view", { ...formResource, data },
      catalogFieldPolicy("guest_hub_service_orders"), form.now)));
  });
}
