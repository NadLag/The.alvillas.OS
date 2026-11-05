import { createServer } from "node:http";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { Money } from "@/platform/money/money";
import { PayPalPaymentProvider } from "@/platform/providers/real";

/** A real local HTTP boundary for the production provider adapter; no live provider/account settings. */
export async function paypalHttpFixture(orderId: string, fee = "0.00") {
  const captureId = "ORIGINAL_CAPTURE_" + randomUUID(), amount = Money.of("0.07", "MAD"), net = amount.subtract(Money.of(fee, "MAD"));
  let capturedAt: string | null = null, posts = 0, lookups = 0;
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
      posts++; capturedAt ??= new Date().toISOString(); response.end(JSON.stringify(completed())); return;
    }
    response.statusCode = 404; response.end("{}");
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening"); const address = server.address(); if (!address || typeof address === "string") throw Error("Owned local payment fixture required");
  return { provider: new PayPalPaymentProvider({ PAYPAL_CLIENT_ID: "local-capture-fixture", PAYPAL_SECRET: "local-capture-fixture", PAYPAL_BASE_URL: "http://127.0.0.1:" + address.port }),
    facts: () => ({ captureId, capturedAt, posts, lookups }), close: () => new Promise<void>((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeAllConnections(); }) };
}
