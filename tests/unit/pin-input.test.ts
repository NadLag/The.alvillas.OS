import { describe, expect, it } from "vitest";
import { normalizePinInput } from "@/modules/identity/domain/pin-input";
import { activationInputSchema } from "@/modules/identity/domain/identity";

describe("field PIN input", () => {
  it.each([["654321", "654321"], ["٦٥٤٣٢١", "654321"], ["۶۵۴۳۲۱", "654321"], ["٦5۴٣2۱", "654321"], ["٠٠١٢٣٤", "001234"]])("uses the same credential for supported numeral forms: %s", (value, expected) => {
    expect(normalizePinInput(value)).toBe(expected);
  });
  it("retains invalid characters so the existing server verifier rejects them", () => {
    const pin = normalizePinInput("٦٥a٤٣٢١");
    expect(pin).toContain("a");
    expect(activationInputSchema.safeParse({ code: "local-invitation-only", phone: "+212612345678", pin }).success).toBe(false);
  });
});
