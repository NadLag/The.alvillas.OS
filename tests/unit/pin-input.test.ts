import { describe, expect, it } from "vitest";
import { normalizePinInput } from "@/modules/identity/domain/pin-input";
import { activationInputSchema } from "@/modules/identity/domain/identity";

describe("field PIN input", () => {
  it.each(["654321", "٦٥٤٣٢١", "۶۵۴۳۲۱", "٦5۴٣2۱"])("uses the same credential for supported numeral forms: %s", value => {
    expect(normalizePinInput(value)).toBe("654321");
  });
  it("retains invalid characters so the existing server verifier rejects them", () => {
    const pin = normalizePinInput("٦٥a٤٣٢١");
    expect(pin).toContain("a");
    expect(activationInputSchema.safeParse({ code: "local-invitation-only", phone: "+212612345678", pin }).success).toBe(false);
  });
});
