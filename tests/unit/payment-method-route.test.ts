import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { paymentMethodCatalogInputSchema, PaymentMethodAccessError, PaymentMethodChangedError, PaymentMethodConfigurationError, PaymentMethodSourceError } from "@/modules/finance/domain/payment-method";
const boundary = vi.hoisted(() => ({ auth: vi.fn(), actor: vi.fn(), read: vi.fn(), capture: vi.fn() }));
vi.mock("@/platform/auth/session", () => ({ auth: boundary.auth }));
vi.mock("@/modules/finance/application/finance-access", () => ({ financeActorContextFromSession: boundary.actor }));
vi.mock("@/modules/finance/application/payment-method-service", () => ({ readPaymentMethodCatalog: boundary.read }));
vi.mock("@/platform/observability/sentry", () => ({ captureException: boundary.capture }));
import { POST } from "@/app/api/finance/payment-methods/editor/route";
const origin = "http://localhost:3194", actor = { organizationId: randomUUID(), actorId: randomUUID() },
  catalog = { policy: { id: randomUUID(), version: 1 }, currency: "EUR", currencies: [{ code: "EUR", minorUnit: 2 }], methods: [] };
const request = (body: unknown = { currency: "EUR" }, from = origin, type = "application/json", query = "") => new NextRequest(origin + "/api/finance/payment-methods/editor" + query,
  { method: "POST", headers: { origin: from, host: "localhost:3194", "content-type": type }, body: JSON.stringify(body) });
function privateResponse(response: Response) { expect(response.headers.get("cache-control")).toBe("private, no-store"); expect(response.headers.get("vary")).toBe("Cookie, Origin"); }
describe("private actual payment method choices", () => {
  beforeEach(() => { vi.clearAllMocks(); boundary.auth.mockResolvedValue({ user: { id: actor.actorId } }); boundary.actor.mockResolvedValue(actor); boundary.read.mockImplementation((_actor, input) => { paymentMethodCatalogInputSchema.parse(input); return Promise.resolve(catalog); }); });
  it("returns choices only through the authenticated native application service", async () => {
    const response = await POST(request()); expect(response.status).toBe(200); privateResponse(response); expect(await response.json()).toEqual(catalog);
    expect(boundary.read.mock.calls[0][0]).toBe(actor); expect(boundary.read.mock.calls[0][1]).toEqual({ currency: "EUR" });
  });
  it("rejects an unauthenticated caller before consulting private configuration", async () => {
    boundary.actor.mockResolvedValue(null); const response = await POST(request()); expect(response.status).toBe(401); privateResponse(response); expect(boundary.read).not.toHaveBeenCalled();
  });
  it.each([["https://foreign.example", "application/json", "", 403], [origin, "text/plain", "", 403], [origin, "application/json", "?organization=foreign", 400]] as const)("rejects origin, content type and injected query state %#", async (from, type, query, status) => {
    const response = await POST(request({}, from, type, query)); expect(response.status).toBe(status); privateResponse(response); expect(boundary.read).not.toHaveBeenCalled();
  });
  it.each([{ currency: "eur" }, { currency: "EUR", organizationId: randomUUID() }])("rejects malformed currency and caller-supplied tenant selection %#", async input => {
    const response = await POST(request(input)); expect(response.status).toBe(400); privateResponse(response);
  });
  it("rejects oversized JSON before it reaches the catalog", async () => {
    const response = await POST(request({ padding: "x".repeat(5000) })); expect(response.status).toBe(400); privateResponse(response); expect(boundary.read).not.toHaveBeenCalled();
  });
  it.each([[new PaymentMethodAccessError(), 403, "forbidden"], [new PaymentMethodChangedError(), 409, "conflict"], [new PaymentMethodConfigurationError(), 409, "configuration_unavailable"], [new PaymentMethodSourceError(), 409, "source_unavailable"]] as const)("returns a private domain failure without provider or source details %#", async (error, status, code) => {
    boundary.read.mockRejectedValue(error); const response = await POST(request()); expect(response.status).toBe(status); privateResponse(response); expect(await response.json()).toEqual({ error: code }); expect(boundary.capture).not.toHaveBeenCalled();
  });
});
