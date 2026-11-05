import { describe, expect, it } from "vitest";
import { payPalCaptureSettlement, paymentCaptureIntent } from "@/platform/providers/payment-capture";
const intent = paymentCaptureIntent({ source: "ACTUAL_ORDER", amount: "0.07", currency: "MAD" });
function original() { return { gross_amount: { value: "0.07", currency_code: "MAD" }, paypal_fee: { value: "0.02", currency_code: "MAD" }, net_amount: { value: "0.05", currency_code: "MAD" } }; }
describe("actual provider gross, deductions and merchant net", () => {
  it("retains exact seven-cent gross, two-cent deduction and five-cent physical merchant net", () => {
    expect(payPalCaptureSettlement(original(), intent)).toEqual({ schemaVersion: 1, basis: "ORIGINAL_PROVIDER_RECEIVABLE_BREAKDOWN", gross: { amount: "0.07", currency: "MAD" }, fee: { amount: "0.02", currency: "MAD" }, net: { amount: "0.05", currency: "MAD" } });
  });
  it("derives deductions from actual gross and net when the fee field is absent", () => { const source = original(); Reflect.deleteProperty(source, "paypal_fee"); expect(payPalCaptureSettlement(source, intent)?.fee.amount).toBe("0.02"); });
  it("does not infer a zero deduction from missing settlement evidence", () => { expect(payPalCaptureSettlement(undefined, intent)).toBeNull(); });
  it.each(["gross_amount", "paypal_fee", "net_amount"] as const)("rejects a substituted currency on %s", key => { const source = original(); source[key].currency_code = "EUR"; expect(payPalCaptureSettlement(source, intent)).toBeNull(); });
  it("rejects an inconsistent deduction instead of overstating held money", () => { const source = original(); source.paypal_fee.value = "0.01"; expect(payPalCaptureSettlement(source, intent)).toBeNull(); });
  it("rejects a different original gross", () => { const source = original(); source.gross_amount.value = "0.08"; expect(payPalCaptureSettlement(source, intent)).toBeNull(); });
  it("retains exact amounts above the JavaScript integer limit without binary rounding", () => { expect(payPalCaptureSettlement({ gross_amount: { value: "9007199254740993.07", currency_code: "MAD" }, paypal_fee: { value: "0.02", currency_code: "MAD" }, net_amount: { value: "9007199254740993.05", currency_code: "MAD" } }, paymentCaptureIntent({ source: "ACTUAL_ORDER", amount: "9007199254740993.07", currency: "MAD" }))?.net.amount).toBe("9007199254740993.05"); });
});
