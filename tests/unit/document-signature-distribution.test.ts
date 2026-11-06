import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { signatureDistributionCommandSchema, signatureDistributionReceiptSchema, signatureDistributionRecoverySchema } from "@/modules/documents/domain/document-signature-distribution";

const command = () => ({ preparationId: randomUUID(), delivery: "EMAIL", idempotencyKey: randomUUID(), reviewFingerprint: "a".repeat(64), reason: "Explicitly distribute the reviewed private original" });
describe("explicit original signature distribution", () => {
  it("requires a separate reviewed email command bound to the actual native preparation", () => { const input = command(); expect(signatureDistributionCommandSchema.parse(input)).toEqual(input); });
  it.each(["delivery", "preparationId", "reviewFingerprint", "idempotencyKey", "reason"])("requires the explicit %s rather than deriving another effect from a preparation", key => {
    const input: Record<string, unknown> = command(); delete input[key]; expect(signatureDistributionCommandSchema.safeParse(input).success).toBe(false);
  });
  it("rejects caller-generated provider outcomes, contacts, tenants and implicit distribution methods", () => {
    for (const change of [{ organizationId: randomUUID() }, { providerRequestId: "unverified-request" }, { state: "SENT" }, { recipientEmail: "substituted@example.test" }, { delivery: "NONE" }, { signingUrl: "https://private.example.test/capability" }]) expect(signatureDistributionCommandSchema.safeParse({ ...command(), ...change }).success).toBe(false);
  });
  it("keeps unrecorded recovery distinct from a known uncertain external effect", () => {
    const input = command(), recorded = { recorded: true, id: randomUUID(), preparationId: input.preparationId, signatureId: randomUUID(), idempotencyKey: input.idempotencyKey, state: "UNCERTAIN" };
    expect(signatureDistributionReceiptSchema.parse(recorded).state).toBe("UNCERTAIN"); expect(signatureDistributionRecoverySchema.parse({ recorded: false, id: null, idempotencyKey: input.idempotencyKey, state: null }).recorded).toBe(false);
    for (const state of ["SIGNED", "COMPLETED", "NO_EFFECT"]) expect(signatureDistributionReceiptSchema.safeParse({ ...recorded, state }).success).toBe(false);
  });
});
