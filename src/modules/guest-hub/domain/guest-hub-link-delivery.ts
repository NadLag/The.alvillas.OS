import { z } from "zod";
import { guestHubLinkDeliveryChannelSchema } from "@/platform/config/guest-hub-link-delivery-policy";
import { guestHubIdSchema } from "./guest-hub-contract";

const review = z.string().max(140).regex(/^[a-zA-Z0-9_-]+\.[a-f0-9]{64}$/u);
export const guestHubLinkDeliveryDraftSchema = z.object({ linkId: guestHubIdSchema, channel: guestHubLinkDeliveryChannelSchema }).strict();
export const guestHubLinkDeliveryCommandSchema = guestHubLinkDeliveryDraftSchema.extend({ reviewFingerprint: review }).strict();
export const guestHubLinkDeliveryReviewSchema = guestHubLinkDeliveryDraftSchema.extend({
  recipientLabel: z.string().min(1).max(320), reviewFingerprint: review
}).strict();
export const guestHubLinkDeliveryReceiptSchema = z.discriminatedUnion("channel", [
  z.object({ channel: z.literal("EMAIL"), linkId: guestHubIdSchema, queued: z.literal(true) }).strict(),
  z.object({ channel: z.literal("WHATSAPP"), linkId: guestHubIdSchema, draftUrl: z.url()
    .refine(value => { const url = new URL(value); return url.origin === "https://wa.me" && !url.username && !url.password; }) }).strict()
]);

export class GuestHubLinkDeliveryAccessError extends Error {
  constructor() { super("guest_link_delivery_not_available"); }
}
