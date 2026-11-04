import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { varianceCommandInputSchema, varianceCommandReceiptSchema, varianceDetailSchema } from "@/modules/finance/domain/variance-workspace";

const source = { provider: "BANK" as const, id: randomUUID() }, eventId = randomUUID();
const intent = { source, operation: "RESOLVE" as const, version: "9007199254740993", sourceFingerprint: "a".repeat(64), reason: "Retain actual provider evidence", action: "Retain the original four-cent difference" };
const receipt = { requestId: eventId, eventId, state: "SUCCEEDED", failureCode: null, idempotencyKey: randomUUID(), source, version: "9007199254740994", operation: "RESOLVE", intent, idempotent: false };
describe("private variance wire acknowledgements", () => {
  it("uses the same canonical UUID nonce for command locking, storage and recovery", () => {
    expect(varianceCommandInputSchema.parse({ intent, idempotencyKey: receipt.idempotencyKey.toUpperCase() }).idempotencyKey).toBe(receipt.idempotencyKey);
  });
  it.each(["abc", "1.5", "-1", "01", "1e3", "9223372036854775808", " "])("rejects malformed original versions without an arithmetic exception: %s", version => {
    const input = { intent: { ...intent, version }, idempotencyKey: randomUUID() };
    expect(() => varianceCommandInputSchema.safeParse(input)).not.toThrow();
    expect(varianceCommandInputSchema.safeParse(input).success).toBe(false);
    expect(() => varianceCommandReceiptSchema.safeParse({ ...receipt, version })).not.toThrow();
    expect(varianceCommandReceiptSchema.safeParse({ ...receipt, version }).success).toBe(false);
  });
  it("retains exact original versions beyond Number precision", () => { expect(varianceCommandReceiptSchema.parse(receipt).version).toBe("9007199254740994"); });
  it.each([
    { eventId: randomUUID() }, { source: { ...source, id: randomUUID() } }, { operation: "ASSIGN" },
    { version: "9007199254740993" }, { version: "9223372036854775808" }, { intent: { ...intent, source: { ...source, provider: "OTA" } } }
  ])("rejects an acknowledgement that substitutes original effect facts %#", replacement => {
    expect(varianceCommandReceiptSchema.safeParse({ ...receipt, ...replacement }).success).toBe(false);
  });
  it("rejects monetary data disguised as a physical quantity and incompatible currency units", () => {
    const detail = { version: "0", source, sourceFingerprint: intent.sourceFingerprint, status: "OPEN", assignedTo: null, reason: "Original actual difference", action: null,
      resolvedBy: null, resolvedAt: null, ageMilliseconds: "1", facts: { kind: "MONEY", currency: "MAD", unit: "MONEY:MAD", expected: "0.07", actual: "0.03", variance: "-0.04" } };
    expect(varianceDetailSchema.safeParse(detail).success).toBe(true);
    expect(varianceDetailSchema.safeParse({ ...detail, facts: { ...detail.facts, currency: "EUR" } }).success).toBe(false);
    expect(varianceDetailSchema.safeParse({ ...detail, facts: { ...detail.facts, kind: "QUANTITY", currency: null, unit: "QUANTITY:pieces" } }).success).toBe(false);
  });
});
