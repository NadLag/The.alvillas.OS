import { describe, expect, it, vi } from "vitest";
import { PayPalPaymentProvider, type HttpTransport } from "@/platform/providers/real";

const input = { amount: "9007199254740993.07", currency: "EUR", source: "ORDER-ORIGINAL-1" };
function confirmed() { return { id: input.source, status: "COMPLETED", purchase_units: [{ payments: { captures: [{ id: "CAPTURE-ORIGINAL-1", status: "COMPLETED", amount: { value: input.amount, currency_code: input.currency } }] } }] }; }
function response(body: unknown, status = 200): Awaited<ReturnType<HttpTransport>> {
  return { ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body), text: () => Promise.resolve(JSON.stringify(body)), arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)) };
}
function provider(body: unknown, status = 201) {
  const transport = vi.fn<HttpTransport>().mockResolvedValueOnce(response({ access_token: "fixture-only-token" })).mockResolvedValueOnce(response(body, status));
  return { transport, adapter: new PayPalPaymentProvider({ PAYPAL_CLIENT_ID: "fixture-client", PAYPAL_SECRET: "fixture-secret", PAYPAL_BASE_URL: "https://api-m.sandbox.paypal.com" }, transport) };
}

describe("original payment capture evidence", () => {
  it("returns the actual completed capture identity with exact cents beyond safe integers", async () => {
    const { adapter, transport } = provider(confirmed()); await expect(adapter.record(input)).resolves.toEqual({ paymentId: "CAPTURE-ORIGINAL-1" });
    expect(transport).toHaveBeenCalledTimes(2); expect(transport.mock.calls[1]?.[0]).toBe("https://api-m.sandbox.paypal.com/v2/checkout/orders/ORDER-ORIGINAL-1/capture");
  });
  it.each(["PENDING", "DECLINED", "FAILED", "REFUNDED", "PARTIALLY_REFUNDED"])("refuses a %s capture before it can be represented as received money", async status => {
    const body = confirmed(); body.purchase_units[0].payments.captures[0].status = status;
    await expect(provider(body).adapter.record(input)).rejects.toThrow("payment_capture_unverified");
  });
  it.each([{ value: "9007199254740993.06", currency_code: "EUR" }, { value: input.amount, currency_code: "MAD" },
    { value: "9007199254740993.071", currency_code: "EUR" }, { value: "0.00", currency_code: "EUR" }])("refuses a different amount, currency or precision in original capture evidence %#", async amount => {
    const body = confirmed(); body.purchase_units[0].payments.captures[0].amount = amount;
    await expect(provider(body).adapter.record(input)).rejects.toThrow("payment_capture_unverified");
  });
  it("binds the confirmation to the original order rather than an unrelated provider response", async () => {
    const body = confirmed(); body.id = "ORDER-OTHER"; await expect(provider(body).adapter.record(input)).rejects.toThrow("payment_capture_unverified");
  });
  it("requires actual capture evidence and a nonempty capture identity", async () => {
    await expect(provider({ id: input.source, status: "COMPLETED" }).adapter.record(input)).rejects.toThrow("payment_capture_unverified");
    const body = confirmed(); body.purchase_units[0].payments.captures[0].id = "";
    await expect(provider(body).adapter.record(input)).rejects.toThrow("payment_capture_unverified");
  });
  it("refuses an ambiguous multiple-capture response through the legacy single-payment interface", async () => {
    const body = confirmed(); body.purchase_units[0].payments.captures.push({ ...body.purchase_units[0].payments.captures[0], id: "CAPTURE-OTHER" });
    await expect(provider(body).adapter.record(input)).rejects.toThrow("payment_capture_unverified");
  });
  it.each([{ ...input, amount: "-0.01" }, { ...input, amount: "0.00" }, { ...input, amount: "0.071" }, { ...input, amount: "1e10" },
    { ...input, currency: "eur" }, { ...input, source: "" }])("rejects an invalid payment intent before external capture %#", async invalid => {
    const { adapter, transport } = provider(confirmed()); await expect(adapter.record(invalid)).rejects.toThrow("payment_capture_unverified"); expect(transport).not.toHaveBeenCalled();
  });
  it("withholds raw provider error bodies from diagnostics", async () => {
    const secretMarker = "fixture-provider-private-response-marker", { adapter } = provider({ private: secretMarker }, 422);
    let failure: unknown; try { await adapter.record(input); } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(Error); expect(String(failure)).not.toContain(secretMarker); expect(String(failure)).toContain("422");
  });
  it("retains the same external idempotency identity for equivalent exact decimal intents", async () => {
    const body = confirmed(); body.purchase_units[0].payments.captures[0].amount.value = "100.00";
    const first = provider(body), second = provider(body); await first.adapter.record({ ...input, amount: "100" }); await second.adapter.record({ ...input, amount: "100.00" });
    expect(first.transport.mock.calls[1]?.[1].headers?.["PayPal-Request-Id"]).toBe(second.transport.mock.calls[1]?.[1].headers?.["PayPal-Request-Id"]);
    expect(first.transport.mock.calls[1]?.[1].headers?.Prefer).toBe("return=representation");
  });
  it("redacts failed OAuth responses before an external capture is attempted", async () => {
    const secretMarker = "fixture-oauth-private-response-marker", { adapter, transport } = provider(confirmed());
    transport.mockReset().mockResolvedValueOnce(response({ private: secretMarker }, 401));
    let failure: unknown; try { await adapter.record(input); } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(Error); expect(String(failure)).not.toContain(secretMarker); expect(String(failure)).toContain("401"); expect(transport).toHaveBeenCalledTimes(1);
  });
  it("redacts malformed capture JSON rather than propagating response fragments", async () => {
    const secretMarker = "fixture-invalid-json-private-marker", { adapter, transport } = provider(confirmed());
    transport.mockReset().mockResolvedValueOnce(response({ access_token: "fixture-only-token" })).mockResolvedValueOnce({ ...response({}), json: () => Promise.reject(new SyntaxError(secretMarker)) });
    let failure: unknown; try { await adapter.record(input); } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(Error); expect(String(failure)).toContain("payment_capture_unverified"); expect(String(failure)).not.toContain(secretMarker);
  });
});
