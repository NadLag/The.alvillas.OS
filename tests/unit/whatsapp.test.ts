import { describe, expect, it } from "vitest";
import { optionalGuestPhoneSchema, whatsappPhone, whatsappRequestSchema, whatsappUrl } from "@/platform/notifications/whatsapp";

describe("manual WhatsApp links", () => {
  it("normalizes validated international numbers including Arabic digits without guessing a country", () => {
    for (const input of ["+212 612-345678", "+٢١٢ ٦١٢٣٤٥٦٧٨", "+۲۱۲ ۶۱۲۳۴۵۶۷۸"]) expect(whatsappPhone(input)).toBe("+212612345678");
    expect(optionalGuestPhoneSchema.parse(" ")).toBeUndefined();
    expect(optionalGuestPhoneSchema.parse("+212 612345678")).toBe("+212612345678");
  });
  it("rejects missing, local, invalid, extended and injected phone numbers", () => {
    for (const input of [null, undefined, "", "0612345678", "00212612345678", "+99912345678", "+212123", "+212612345678 ext 1", "+212612345678?text=leak", "Call +212612345678", "+212612345678\n&text=leak"]) expect(whatsappPhone(input)).toBeNull();
    expect(optionalGuestPhoneSchema.safeParse("invalid").success).toBe(false);
  });
  it("encodes EN, FR and Arabic content into a fixed HTTPS origin with one text parameter", () => {
    const message = "Bonjour & مرحباً\n100% + #? = <script> / é 🏡";
    const result = new URL(whatsappUrl("+212612345678", message));
    expect(result.origin).toBe("https://wa.me"); expect(result.pathname).toBe("/212612345678");
    expect([...result.searchParams]).toEqual([["text", message]]);
    expect(() => whatsappUrl("javascript:alert(1)", message)).toThrow();
    expect(() => whatsappUrl("+212612345678", "x".repeat(4001))).toThrow();
  });
  it("accepts only canonical scoped references and localized template requests", () => {
    const id = "018f0a0b-0000-7000-9000-000000000001";
    const request = { source: { type: "reservation", id }, recipient: { kind: "guest", id }, locale: "fr" };
    expect(whatsappRequestSchema.safeParse(request).success).toBe(true);
    for (const input of [{ ...request, phone: "+212612345678" }, { ...request, message: "Leak" }, { ...request, locale: "xx" }, { ...request, source: { type: "reservation", id: "foreign" } }, { ...request, href: "https://evil.test" }]) expect(whatsappRequestSchema.safeParse(input).success).toBe(false);
  });
});
