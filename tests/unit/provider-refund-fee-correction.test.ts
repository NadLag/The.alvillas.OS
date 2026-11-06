import { describe, expect, it } from "vitest";
import { Money } from "@/platform/money/money";
import { providerRefundFeeCorrectionTarget } from "@/modules/finance/domain/provider-refund-fee-correction";

const money = (amount: string, currency = "MAD") => Money.of(amount, currency), base = () => ({ originalFee: money("0.02"), currentCost: money("0.02"), gross: money("0.03"), returnedFee: money("0.01"), merchantDebit: money("0.02") });
describe("verified original provider fee return cost targets", () => {
  it("retains the exact remaining original cost after a partial provider fee credit", () => {
    const target = providerRefundFeeCorrectionTarget(base()); expect(target.remainingCost.toJSON()).toEqual({ amount: "0.01", currency: "MAD" }); expect(target.disposition).toBe("CORRECT_ORIGINAL_REMAINDER");
  });
  it("finishes cumulative partial credits with a native opposite rather than a zero-cost expense", () => {
    const target = providerRefundFeeCorrectionTarget({ ...base(), currentCost: money("0.01"), gross: money("0.04"), merchantDebit: money("0.03") });
    expect(target.remainingCost.toJSON()).toEqual({ amount: "0.00", currency: "MAD" }); expect(target.disposition).toBe("VOID_ORIGINAL_REMAINDER");
  });
  it("conserves the smallest supported cent when the merchant debit is actually zero", () => {
    const target = providerRefundFeeCorrectionTarget({ ...base(), originalFee: money("0.01"), currentCost: money("0.01"), gross: money("0.01"), merchantDebit: money("0.00") }); expect(target.remainingCost.toJSON().amount).toBe("0.00");
  });
  it.each(["originalFee", "currentCost", "gross", "returnedFee", "merchantDebit"] as const)("rejects a foreign-currency %s rather than inferring conversion or cost ownership", field => {
    expect(() => providerRefundFeeCorrectionTarget({ ...base(), [field]: money("0.01", "EUR") })).toThrow();
  });
  it.each([["originalFee", "0.00"], ["currentCost", "0.00"], ["gross", "0.00"], ["returnedFee", "0.00"], ["merchantDebit", "-0.01"]] as const)("rejects unsupported %s value %s", (field, amount) => {
    expect(() => providerRefundFeeCorrectionTarget({ ...base(), [field]: money(amount) })).toThrow();
  });
  it("rejects an increased source cost that exceeds the original capture expense", () => { expect(() => providerRefundFeeCorrectionTarget({ ...base(), currentCost: money("0.03") })).toThrow(); });
  it("does not assign excess provider credits to an invented original cost owner", () => { expect(() => providerRefundFeeCorrectionTarget({ ...base(), gross: money("0.05"), returnedFee: money("0.03") })).toThrow(); });
  it("requires the actual original gross minus the verified fee to equal the actual merchant debit", () => { expect(() => providerRefundFeeCorrectionTarget({ ...base(), merchantDebit: money("0.01") })).toThrow(); });
  it.each(["0.01", "0.02"])("conserves both the merchant and original cost for a %s returned fee", value => {
    const original = money("0.02"), gross = money("0.07"), returned = money(value), target = providerRefundFeeCorrectionTarget({ originalFee: original, currentCost: original, gross, returnedFee: returned, merchantDebit: gross.subtract(returned) });
    expect(original.subtract(target.remainingCost).equals(returned)).toBe(true);
  });
});
