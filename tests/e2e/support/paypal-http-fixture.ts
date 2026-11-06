import { createServer } from "node:http";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { Money } from "@/platform/money/money";
import { PayPalPaymentProvider } from "@/platform/providers/real";

/** A real local HTTP boundary for the production provider adapter; no live provider/account settings. */
export async function paypalHttpFixture(orderId: string, fee = "0.00", returnedFees: readonly string[] = [], clock: () => Promise<Date> | Date = () => new Date()) {
  const captureId = "ORIGINAL_CAPTURE_" + randomUUID(), amount = Money.of("0.07", "MAD"), net = amount.subtract(Money.of(fee, "MAD"));
  let capturedAt: string | null = null, posts = 0, lookups = 0, refundPosts = 0, refundLookups = 0, refunded = Money.zero("MAD"), creditedFee = Money.zero("MAD");
  const refunds = new Map<string, object>();
  const server = createServer((request, response) => {
    response.setHeader("Content-Type", "application/json");
    if (request.method === "POST" && request.url === "/v1/oauth2/token") { response.end(JSON.stringify({ access_token: "local-capture-fixture" })); return; }
    if (request.headers.authorization !== "Bearer local-capture-fixture") { response.statusCode = 401; response.end("{}"); return; }
    const original = { id: orderId, intent: "CAPTURE", purchase_units: [{ amount: { value: "0.07", currency_code: "MAD" } }] };
    const completed = () => ({ id: orderId, status: "COMPLETED", purchase_units: [{ payments: { captures: [{ id: captureId, status: "COMPLETED", create_time: capturedAt,
      amount: { value: "0.07", currency_code: "MAD" }, seller_receivable_breakdown: { gross_amount: { value: "0.07", currency_code: "MAD" }, paypal_fee: { value: fee, currency_code: "MAD" }, net_amount: { value: net.toJSON().amount, currency_code: "MAD" } } }] } }] });
    if (request.method === "GET" && request.url === "/v2/checkout/orders/" + orderId) { lookups++; response.end(JSON.stringify(capturedAt ? completed() : { ...original, status: "APPROVED" })); return; }
    if (request.method === "POST" && request.url === "/v2/checkout/orders/" + orderId + "/capture") {
      if (!request.headers["paypal-request-id"]) { response.statusCode = 400; response.end("{}"); return; }
      posts++; void Promise.resolve().then(clock).then(at => { capturedAt ??= at.toISOString(); response.end(JSON.stringify(completed())); }).catch(() => { response.statusCode = 503; response.end("{}"); }); return;
    }
    if (request.method === "POST" && request.url === "/v2/payments/captures/" + captureId + "/refund") {
      let raw = ""; request.setEncoding("utf8"); request.on("data", chunk => { raw += chunk; }); request.on("end", () => { void (async () => {
        try {
          const input = z.object({ custom_id: z.uuid(), amount: z.object({ value: z.string().regex(/^(?:0|[1-9]\d*)\.\d{2}$/u), currency_code: z.literal("MAD") }).strict() }).strict().parse(JSON.parse(raw)), requestId = request.headers["paypal-request-id"];
          if (!capturedAt || typeof requestId !== "string" || input.custom_id !== requestId || input.amount?.currency_code !== "MAD") throw Error();
          const gross = Money.of(input.amount.value, "MAD"), credit = Money.of(returnedFees[refundPosts] ?? "0.00", "MAD");
          if (!gross.amount.gt(0) || refunded.add(gross).amount.gt(amount.amount) || credit.amount.lt(0) || credit.amount.gt(gross.amount) || creditedFee.add(credit).amount.gt(Money.of(fee,"MAD").amount)) throw Error();
          const refundId = "ORIGINAL_REFUND_" + randomUUID(), at = (await clock()).toISOString(), address = server.address(); if (!address || typeof address === "string") throw Error();
          refunded = refunded.add(gross); creditedFee = creditedFee.add(credit); refundPosts++;
          const result = { id: refundId, custom_id: requestId, status: "COMPLETED", amount: { value: gross.toJSON().amount, currency_code: "MAD" }, create_time: at, update_time: at,
            links: [{ rel: "up", method: "GET", href: "http://127.0.0.1:" + address.port + "/v2/payments/captures/" + captureId }],
            seller_payable_breakdown: { gross_amount: { value: gross.toJSON().amount, currency_code: "MAD" }, paypal_fee: { value: credit.toJSON().amount, currency_code: "MAD" }, net_amount: { value: gross.subtract(credit).toJSON().amount, currency_code: "MAD" }, total_refunded_amount: { value: refunded.toJSON().amount, currency_code: "MAD" } } };
          refunds.set(refundId, result); response.end(JSON.stringify(result));
        } catch { response.statusCode = 400; response.end("{}"); }
      })(); }); return;
    }
    if (request.method === "GET" && request.url?.startsWith("/v2/payments/refunds/")) {
      const refund = refunds.get(request.url.slice("/v2/payments/refunds/".length)); if (!refund) { response.statusCode = 404; response.end("{}"); return; }
      refundLookups++; response.end(JSON.stringify(refund)); return;
    }
    response.statusCode = 404; response.end("{}");
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening"); const address = server.address(); if (!address || typeof address === "string") throw Error("Owned local payment fixture required");
  return { provider: new PayPalPaymentProvider({ PAYPAL_CLIENT_ID: "local-capture-fixture", PAYPAL_SECRET: "local-capture-fixture", PAYPAL_BASE_URL: "http://127.0.0.1:" + address.port }),
    facts: () => ({ captureId, capturedAt, posts, lookups, refundPosts, refundLookups, refunded: refunded.toJSON(), creditedFee: creditedFee.toJSON() }),
    observeRefund: async (refundId: string, state: "PENDING" | "FAILED" | "CANCELLED" | "COMPLETED") => {
      const original = z.object({ update_time: z.iso.datetime(), seller_payable_breakdown: z.unknown().optional() }).passthrough().parse(refunds.get(refundId)), at = (await clock()).toISOString();
      if (at <= original.update_time) throw Error("Later provider fixture observation requires a later owned clock instant");
      const { seller_payable_breakdown: ignored, ...retained } = original; void ignored;
      refunds.set(refundId, { ...retained, status: state, update_time: at });
    },
    close: () => new Promise<void>((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeAllConnections(); }) };
}
