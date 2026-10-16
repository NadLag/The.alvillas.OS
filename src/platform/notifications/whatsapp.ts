import { z } from "zod";
import { parsePhoneNumberFromString } from "libphonenumber-js/max";

export function whatsappPhone(value: string | null | undefined): string | null {
  if (!value || value.length > 60) return null;
  const input = value.trim().normalize("NFKC").replace(/[٠-٩۰-۹]/gu, (digit) => String(digit.charCodeAt(0) - (digit >= "۰" ? 0x6f0 : 0x660)));
  // Require an explicit international prefix. Never guess the recipient's country.
  if (!/^\+[0-9 ()-]+$/u.test(input)) return null;
  const phone = parsePhoneNumberFromString(input, { extract: false });
  return phone?.isValid() && !phone.ext ? phone.number : null;
}

export const optionalGuestPhoneSchema = z.preprocess(
  (value) => typeof value === "string" && !value.trim() ? undefined : value,
  z.string().max(60).refine((value) => Boolean(whatsappPhone(value))).transform((value) => whatsappPhone(value)!).optional()
);
export const whatsappSourceSchema = z.object({ type: z.enum(["reservation", "task", "notification"]), id: z.string().uuid() }).strict();
export type WhatsappSource = z.infer<typeof whatsappSourceSchema>;
export const whatsappRecipientSchema = z.object({ kind: z.enum(["guest", "owner", "operations"]), id: z.string().uuid() }).strict();
export const whatsappRequestSchema = z.object({ source: whatsappSourceSchema, recipient: whatsappRecipientSchema, locale: z.enum(["en", "fr", "ar"]).optional() }).strict();
export type WhatsappRequest = z.infer<typeof whatsappRequestSchema>;
export const whatsappContactSchema = z.object({ source: whatsappSourceSchema, phone: optionalGuestPhoneSchema, locale: z.enum(["en", "fr", "ar"]) }).strict();
export type WhatsappOption = { kind: WhatsappRequest["recipient"]["kind"]; id: string; name: string; locale: "en" | "fr" | "ar" };

export function whatsappUrl(phone: string, message: string): string {
  const normalized = whatsappPhone(phone);
  if (!normalized || !message.trim() || message.length > 4000) throw new Error("Invalid WhatsApp draft");
  return `https://wa.me/${normalized.slice(1)}?text=${encodeURIComponent(message)}`;
}
