import { z } from "zod";

export const guestHubPropertyInformationKey = "guest_hub.property_information";

const phone = z.string().trim().regex(/^\+?[0-9]{2,15}$/u);
const instructions = z.string().trim().min(1).max(1500);

export const guestHubPropertyInformationSchema = z.object({
  wifi: z.object({
    network: z.string().trim().min(1).max(100),
    password: z.string().min(1).max(100).optional()
  }).strict().optional(),
  supportPhone: phone.optional(),
  emergencyPhone: phone.optional(),
  instructions: z.object({ en: instructions, fr: instructions, ar: instructions }).strict().optional()
}).strict();

export const guestHubStoredPropertyInformationSchema = z.object({
  encrypted: z.string().min(1).max(30_000).regex(/^[a-zA-Z0-9_-]+$/u)
}).strict();

export type GuestHubPropertyInformation = z.infer<typeof guestHubPropertyInformationSchema>;
