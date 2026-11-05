import { describe, expect, it } from "vitest";
import { payPalRefundSettlement } from "@/platform/providers/payment-refund-settlement";
const input = { captureId: "ORIGINAL_CAPTURE", requestId: "84e2c5bd-74d7-4c98-8687-c0015c92fd07", amount: "9007199254740993.07", currency: "EUR" },
  money = (value: string, currency_code = "EUR") => ({ value, currency_code });
const breakdown = () => ({ gross_amount: money(input.amount), paypal_fee: money("0.02"), net_amount: money("9007199254740993.05"), total_refunded_amount: money("9007199254740994.00") });
describe("actual original provider refund settlement", () => {
  it("retains gross, fee, net and cumulative provider refunds without losing cents beyond safe integers", () => {
    expect(payPalRefundSettlement(breakdown(), input)).toEqual({ schemaVersion: 1, basis: "ORIGINAL_PROVIDER_PAYABLE_BREAKDOWN",
      gross: { amount: input.amount, currency: "EUR" }, fee: { amount: "0.02", currency: "EUR" }, net: { amount: "9007199254740993.05", currency: "EUR" }, totalRefunded: { amount: "9007199254740994.00", currency: "EUR" } });
  });
  it("requires explicit zero-fee proof before representing a gross merchant debit", () => {
    expect(payPalRefundSettlement({ gross_amount: money(input.amount), paypal_fee: money("0"), net_amount: money(input.amount) }, input)).toMatchObject({ fee: { amount: "0.00" }, net: { amount: input.amount }, totalRefunded: null });
    expect(payPalRefundSettlement({ gross_amount: money(input.amount), net_amount: money(input.amount) }, input)).toBeNull();
  });
  it.each([undefined, null, {}, { gross_amount: money(input.amount) }])("does not infer settlement from incomplete provider evidence %#", raw => { expect(payPalRefundSettlement(raw, input)).toBeNull(); });
  it.each(["gross_amount", "paypal_fee", "net_amount", "total_refunded_amount"] as const)("refuses a foreign %s currency", field => { const raw = breakdown(); raw[field].currency_code = "MAD"; expect(payPalRefundSettlement(raw, input)).toBeNull(); });
  it.each(["0.021", "-0.02", "2e-2"])("refuses an unsupported fee representation %s", value => { const raw = breakdown(); raw.paypal_fee.value = value; expect(payPalRefundSettlement(raw, input)).toBeNull(); });
  it("refuses changed gross, inconsistent net and a cumulative refund below this actual refund", () => {
    expect(payPalRefundSettlement({ ...breakdown(), gross_amount: money("9007199254740993.06") }, input)).toBeNull();
    expect(payPalRefundSettlement({ ...breakdown(), net_amount: money("9007199254740993.04") }, input)).toBeNull();
    expect(payPalRefundSettlement({ ...breakdown(), total_refunded_amount: money("1.00") }, input)).toBeNull();
  });
  it.each([{ paypal_fee_in_receivable_currency: money("0.03") }, { paypal_fee_in_receivable_currency: money("0.02", "MAD") },
    { platform_fees: [{ amount: money("0.01") }] }, { net_amount_breakdown: [{ payable_amount: money("1.00") }] }, { exchange_rate: { value: "1.01" } }])("keeps FX and additional deductions unavailable until their original source treatment is supported %#", extra => {
    expect(payPalRefundSettlement({ ...breakdown(), ...extra }, input)).toBeNull();
  });
});
