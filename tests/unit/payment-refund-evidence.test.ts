import { describe, expect, it, vi } from "vitest";
import { PayPalPaymentProvider, type HttpTransport } from "@/platform/providers/real";
import { paymentRefundIntent } from "@/platform/providers/payment-refund";

const input = { captureId: "CAPTURE-ORIGINAL-1", requestId: "e61ce5fe-645d-4c17-bab2-bc0f6b064754", amount: "9007199254740993.07", currency: "EUR" };
const api = "https://api-m.sandbox.paypal.com";
function confirmed() { return { id: "REFUND-ORIGINAL-1", custom_id: input.requestId, status: "COMPLETED", amount: { value: input.amount, currency_code: "EUR" },
  create_time: "2026-11-05T16:55:00Z", update_time: "2026-11-05T16:56:00Z", links: [{ rel: "up", method: "GET", href: api + "/v2/payments/captures/" + input.captureId }] }; }
function response(body: unknown, status = 200): Awaited<ReturnType<HttpTransport>> {
  return { ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body), text: () => Promise.resolve(JSON.stringify(body)), arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)) };
}
function provider(body: unknown = confirmed(), status = 201) {
  const transport = vi.fn<HttpTransport>().mockResolvedValueOnce(response({ access_token: "fixture-only-token" })).mockResolvedValueOnce(response(body, status));
  return { transport, adapter: new PayPalPaymentProvider({ PAYPAL_CLIENT_ID: "fixture-client", PAYPAL_SECRET: "fixture-secret", PAYPAL_BASE_URL: api }, transport) };
}

describe("original provider refund evidence", () => {
  it("normalizes provider UTC offsets while preserving the actual reported instants", async () => {
    const body = confirmed(); body.create_time = "2026-11-05T09:55:00-07:00"; body.update_time = "2026-11-05T09:56:00-07:00";
    await expect(provider(body).adapter.refund(input)).resolves.toMatchObject({ createdAt: "2026-11-05T16:55:00.000Z", refundedAt: "2026-11-05T16:56:00.000Z" });
  });
  it("posts the exact explicit refund to its original capture with the retained request identity", async () => {
    const { adapter, transport } = provider();
    await expect(adapter.refund(input)).resolves.toEqual({ refundId: "REFUND-ORIGINAL-1", captureId: input.captureId, requestId: input.requestId,
      amount: { amount: input.amount, currency: "EUR" }, state: "COMPLETED", createdAt: "2026-11-05T16:55:00.000Z", updatedAt: "2026-11-05T16:56:00.000Z", refundedAt: "2026-11-05T16:56:00.000Z", settlement: null });
    expect(transport).toHaveBeenCalledTimes(2);
    expect(transport.mock.calls[1]?.[0]).toBe(api + "/v2/payments/captures/" + input.captureId + "/refund");
    expect(transport.mock.calls[1]?.[1].method).toBe("POST");
    expect(transport.mock.calls[1]?.[1].headers?.["PayPal-Request-Id"]).toBe(input.requestId);
    expect(transport.mock.calls[1]?.[1].headers?.Prefer).toBe("return=representation");
    expect(transport.mock.calls[1]?.[1].body).toBe(JSON.stringify({ amount: { value: input.amount, currency_code: "EUR" }, custom_id: input.requestId }));
  });
  it("reconciles only the retained refund by GET and binds the response to that identity", async () => {
    const { adapter, transport } = provider(confirmed(), 200);
    await expect(adapter.lookupRefund({ intent: input, refundId: "REFUND-ORIGINAL-1" })).resolves.toMatchObject({ state: "COMPLETED" });
    expect(transport.mock.calls[1]).toEqual([api + "/v2/payments/refunds/REFUND-ORIGINAL-1", expect.objectContaining({ method: "GET" })]);
    const changed = confirmed(); changed.id = "REFUND-OTHER";
    await expect(provider(changed).adapter.lookupRefund({ intent: input, refundId: "REFUND-ORIGINAL-1" })).rejects.toThrow("payment_refund_unverified");
  });
  it.each(["PENDING", "FAILED", "CANCELLED"])("retains %s evidence without asserting completed money", async status => {
    const body = confirmed(); body.status = status;
    await expect(provider(body).adapter.refund(input)).resolves.toMatchObject({ state: status, refundedAt: null });
  });
  it.each(["capture", "request", "currency", "cents", "precision", "exponent", "negative", "zero", "status", "created", "updated", "time-order", "identity", "missing-parent", "multiple-parents", "parent-origin", "parent-path", "parent-query", "parent-fragment", "parent-auth", "parent-method"])("refuses mismatched or incomplete %s evidence", async field => {
    const body = confirmed();
    switch (field) {
      case "capture": body.links[0].href = api + "/v2/payments/captures/CAPTURE-OTHER"; break;
      case "request": body.custom_id = "e61ce5fe-645d-4c17-bab2-bc0f6b064755"; break;
      case "currency": body.amount.currency_code = "MAD"; break;
      case "cents": body.amount.value = "9007199254740993.06"; break;
      case "precision": body.amount.value = "9007199254740993.070"; break;
      case "exponent": body.amount.value = "9.00719925474099307e15"; break;
      case "negative": body.amount.value = "-9007199254740993.07"; break;
      case "zero": body.amount.value = "0.00"; break;
      case "status": body.status = "UNKNOWN"; break;
      case "created": body.create_time = ""; break;
      case "updated": body.update_time = ""; break;
      case "time-order": body.update_time = "2026-11-05T16:54:00Z"; break;
      case "identity": body.id = ""; break;
      case "missing-parent": body.links = []; break;
      case "multiple-parents": body.links.push({ ...body.links[0] }); break;
      case "parent-origin": body.links[0].href = "https://attacker.invalid/v2/payments/captures/" + input.captureId; break;
      case "parent-path": body.links[0].href += "/refund"; break;
      case "parent-query": body.links[0].href += "?redirect=other"; break;
      case "parent-fragment": body.links[0].href += "#other"; break;
      case "parent-auth": body.links[0].href = body.links[0].href.replace("https://", "https://user:private@"); break;
      case "parent-method": body.links[0].method = "POST"; break;
    }
    const { adapter, transport } = provider(body);
    await expect(adapter.refund(input)).rejects.toThrow("payment_refund_unverified");
    expect(transport).toHaveBeenCalledTimes(2);
  });
  it.each([{ ...input, amount: "0.00" }, { ...input, amount: "-1.00" }, { ...input, amount: "0.071" }, { ...input, amount: "1e3" },
    { ...input, captureId: "../other" }, { ...input, requestId: "not-a-durable-nonce" }, { ...input, currency: "eur" }])("rejects invalid intents before any provider I/O %#", async invalid => {
    const { adapter, transport } = provider(); await expect(adapter.refund(invalid)).rejects.toThrow("payment_refund_unverified"); expect(transport).not.toHaveBeenCalled();
  });
  it("canonicalizes exact decimal money and UUID spelling without generating another identity", () => {
    expect(paymentRefundIntent({ ...input, amount: "1", requestId: input.requestId.toUpperCase() })).toEqual({ ...input, amount: "1.00" });
  });
  it.each([404, 409, 422, 500])("retains a private unresolved outcome on HTTP %s without retrying", async status => {
    const { adapter, transport } = provider({ private: "provider-private-marker" }, status);
    await expect(adapter.refund(input)).rejects.toThrow("payment_refund_unverified:" + status); expect(transport).toHaveBeenCalledTimes(2);
  });
  it.each(["network", "json", "oauth"])("redacts %s failures and never sends another monetary POST", async mode => {
    const { adapter, transport } = provider(), marker = "fixture-private-failure-marker";
    if (mode === "oauth") transport.mockReset().mockRejectedValueOnce(new Error(marker));
    else if (mode === "network") transport.mockReset().mockResolvedValueOnce(response({ access_token: "fixture-only-token" })).mockRejectedValueOnce(new Error(marker));
    else transport.mockReset().mockResolvedValueOnce(response({ access_token: "fixture-only-token" })).mockResolvedValueOnce({ ...response({}), json: () => Promise.reject(new SyntaxError(marker)) });
    let failure: unknown; try { await adapter.refund(input); } catch (error) { failure = error; }
    expect(String(failure)).toContain("payment_refund_unverified"); expect(String(failure)).not.toContain(marker); expect(transport).toHaveBeenCalledTimes(mode === "oauth" ? 1 : 2);
  });
  it("rejects an invalid lookup identity before any external request", async () => {
    const { adapter, transport } = provider(); await expect(adapter.lookupRefund({ intent: input, refundId: "../other" })).rejects.toThrow("payment_refund_unverified"); expect(transport).not.toHaveBeenCalled();
  });
});
