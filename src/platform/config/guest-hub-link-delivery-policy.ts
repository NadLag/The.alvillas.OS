import { z } from "zod";

export const guestHubLinkDeliveryPolicyKey = "guest_hub.link_delivery";
export const guestHubLinkDeliveryChannelSchema = z.enum(["EMAIL", "WHATSAPP"]);
export type GuestHubLinkDeliveryChannel = z.infer<typeof guestHubLinkDeliveryChannelSchema>;

export const guestHubLinkDeliveryPolicySchema = z.object({
  source: z.literal("ORIGINAL_RESERVATION_CONTACT"),
  channels: z.array(guestHubLinkDeliveryChannelSchema).max(2).refine(items => new Set(items).size === items.length),
  approval_reference: z.string().trim().min(1).max(200).nullable()
}).strict().refine(policy => !policy.channels.length || policy.approval_reference !== null, {
  path: ["approval_reference"], message: "guest_link_delivery_approval_required"
});
