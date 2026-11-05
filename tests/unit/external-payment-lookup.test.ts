import { describe, expect, it, vi } from "vitest";
import { paymentCaptureIntent, payPalOrderState, PaymentCaptureEvidenceError } from "@/platform/providers/payment-capture";
import { PayPalPaymentProvider } from "@/platform/providers/real";

const intent = paymentCaptureIntent({ source: "ORIGINAL_ORDER", amount: "9007199254740993.07", currency: "MAD" });
const pending = (status = "APPROVED") => ({ id: intent.source, intent: "CAPTURE", status, purchase_units: [{ amount: { value: intent.amount, currency_code: intent.currency } }] });
const capturedAt = "2026-11-01T23:59:59.000Z";
const settlement = { schemaVersion: 1, basis: "ORIGINAL_PROVIDER_RECEIVABLE_BREAKDOWN", gross: { amount: intent.amount, currency: intent.currency }, fee: { amount: "0.00", currency: intent.currency }, net: { amount: intent.amount, currency: intent.currency } };
const completed = () => ({ id: intent.source, status: "COMPLETED", purchase_units: [{ payments: { captures: [{ id: "ACTUAL_CAPTURE", status: "COMPLETED", create_time: capturedAt, amount: { value: intent.amount, currency_code: intent.currency },
  seller_receivable_breakdown: { gross_amount: { value: intent.amount, currency_code: intent.currency }, paypal_fee: { value: "0.00", currency_code: intent.currency }, net_amount: { value: intent.amount, currency_code: intent.currency } } }] } }] });
describe("read-only original PayPal order recovery", () => {
  it("recovers the actual completed capture without another capture request", () => {
    const original = completed(), before = structuredClone(original);
    expect(payPalOrderState(original, intent)).toEqual({ state: "CAPTURED", paymentId: "ACTUAL_CAPTURE", capturedAt, settlement }); expect(original).toEqual(before);
  });
  it.each(["CREATED", "SAVED", "APPROVED", "PAYER_ACTION_REQUIRED"])("distinguishes exact %s orders from completed money", status => {
    expect(payPalOrderState(pending(status), intent)).toEqual({ state: status === "APPROVED" ? "APPROVED" : "WAITING" });
  });
  it.each(["VOIDED", "COMPLETED", "UNKNOWN"])("refuses an unsupported or unverified %s order", status => {
    expect(() => payPalOrderState(pending(status), intent)).toThrow(PaymentCaptureEvidenceError);
  });
  it.each(["0.00", "9007199254740993.08", "9007199254740993.071", "9e15"])("refuses an approved order with changed or invalid exact amount %s", value => {
    const order = pending(); order.purchase_units[0].amount.value = value;
    expect(() => payPalOrderState(order, intent)).toThrow(PaymentCaptureEvidenceError);
  });
  it("refuses a different order, currency or authorization intent", () => {
    const other = pending(); other.id = "FOREIGN_ORDER";
    expect(() => payPalOrderState(other, intent)).toThrow(PaymentCaptureEvidenceError);
    const currency = pending(); currency.purchase_units[0].amount.currency_code = "EUR";
    expect(() => payPalOrderState(currency, intent)).toThrow(PaymentCaptureEvidenceError);
    const authorization = pending(); authorization.intent = "AUTHORIZE";
    expect(() => payPalOrderState(authorization, intent)).toThrow(PaymentCaptureEvidenceError);
  });
  it("requires one original capture even during read-only recovery", () => {
    const order = completed(); order.purchase_units[0].payments.captures.push(structuredClone(order.purchase_units[0].payments.captures[0]));
    expect(() => payPalOrderState(order, intent)).toThrow(PaymentCaptureEvidenceError);
  });
  it("uses an authenticated GET and never POSTs the order during lost-acknowledgement recovery", async () => {
    const transport = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(JSON.stringify({ access_token: "test-only-oauth" })))
      .mockResolvedValueOnce(new Response(JSON.stringify(completed())));
    const provider = new PayPalPaymentProvider({ PAYPAL_CLIENT_ID: "test-only-client", PAYPAL_SECRET: "test-only-secret", PAYPAL_BASE_URL: "https://api-m.sandbox.paypal.com" }, transport);
    expect(await provider.lookup(intent)).toEqual({ state: "CAPTURED", paymentId: "ACTUAL_CAPTURE", capturedAt, settlement });
    expect(transport).toHaveBeenCalledTimes(2);
    expect(transport.mock.calls[1][0]).toBe("https://api-m.sandbox.paypal.com/v2/checkout/orders/ORIGINAL_ORDER");
    expect(transport.mock.calls[1][1]).toMatchObject({ method: "GET", headers: { Authorization: "Bearer test-only-oauth" } });
    expect(transport.mock.calls.filter(call => typeof call[0] === "string" && call[0].endsWith("/capture"))).toEqual([]);
  });
  it("redacts read-only provider error bodies", async () => {
    const transport = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(JSON.stringify({ access_token: "test-only-oauth" })))
      .mockResolvedValueOnce(new Response("private provider financial diagnostic", { status: 404 }));
    const provider = new PayPalPaymentProvider({ PAYPAL_CLIENT_ID: "test-only-client", PAYPAL_SECRET: "test-only-secret" }, transport);
    await expect(provider.lookup(intent)).rejects.toThrow(/^payment_capture_unverified:404$/u);
  });
  it("requires an actual provider capture time instead of replacing it with reconciliation time", () => {
    const order = completed(); Reflect.deleteProperty(order.purchase_units[0].payments.captures[0], "create_time");
    expect(() => payPalOrderState(order, intent)).toThrow(PaymentCaptureEvidenceError);
  });
  it("refuses an invalid original provider capture clock", () => {
    const order = completed(); order.purchase_units[0].payments.captures[0].create_time = "unknown-clock";
    expect(() => payPalOrderState(order, intent)).toThrow(PaymentCaptureEvidenceError);
  });
  it("retains the actual capture timestamp returned by POST without changing the existing record interface", async () => {
    const transport = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(JSON.stringify({ access_token: "test-only-oauth" })))
      .mockResolvedValueOnce(new Response(JSON.stringify(completed())));
    const provider = new PayPalPaymentProvider({ PAYPAL_CLIENT_ID: "test-only-client", PAYPAL_SECRET: "test-only-secret" }, transport);
    expect(await provider.capture(intent)).toEqual({ paymentId: "ACTUAL_CAPTURE", capturedAt, settlement });
    expect(transport.mock.calls[1][1]).toMatchObject({ method: "POST" });
  });
});
