import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { externalPaymentReadInput, externalPaymentCommandInput, externalPaymentRecoveryInput } from "@/modules/finance/domain/external-payment-command";
import { externalRefundReadInput, externalRefundCommandInput, externalRefundRecoveryInput } from "@/modules/finance/domain/external-payment-refund-command";
import { PaymentMethodAccessError, PaymentMethodChangedError, PaymentMethodConfigurationError, PaymentMethodSourceError } from "@/modules/finance/domain/payment-method";
const boundary = vi.hoisted(() => ({ auth: vi.fn(), actor: vi.fn(), read: vi.fn(), command: vi.fn(), recover: vi.fn(), refundRead: vi.fn(), refundCommand: vi.fn(), refundRecover: vi.fn(), refundStatus: vi.fn(), status: vi.fn(), capture: vi.fn() }));
vi.mock("@/platform/auth/session", () => ({ auth: boundary.auth }));
vi.mock("@/modules/finance/application/finance-access", () => ({ financeActorContextFromSession: boundary.actor }));
vi.mock("@/modules/finance/application/external-payment-api-service", () => ({ readExternalPaymentWorkspace: boundary.read, executeExternalPaymentCommand: boundary.command }));
vi.mock("@/modules/finance/application/external-payment-workspace-service", () => ({ recoverExternalPaymentIntent: boundary.recover, getExternalPaymentIntent: boundary.status }));
vi.mock("@/modules/finance/application/external-payment-refund-api-service", () => ({ readExternalPaymentRefundWorkspace: boundary.refundRead, executeExternalPaymentRefundCommand: boundary.refundCommand }));
vi.mock("@/modules/finance/application/external-payment-refund-workspace-service", () => ({ recoverExternalPaymentRefund: boundary.refundRecover, getExternalPaymentRefund: boundary.refundStatus }));
vi.mock("@/platform/observability/sentry", () => ({ captureException: boundary.capture }));
import { POST as read } from "@/app/api/finance/external-payments/read/route";
import { POST as command } from "@/app/api/finance/external-payments/command/route";
import { POST as recover } from "@/app/api/finance/external-payments/recover/route";
import { GET as status } from "@/app/api/finance/external-payments/status/[id]/route";
import { POST as refundRead } from "@/app/api/finance/external-payments/refunds/read/route";
import { POST as refundCommand } from "@/app/api/finance/external-payments/refunds/command/route";
import { POST as refundRecover } from "@/app/api/finance/external-payments/refunds/recover/route";
import { GET as refundStatus } from "@/app/api/finance/external-payments/refunds/status/[id]/route";
const origin = "http://localhost:3194", actor = { organizationId: randomUUID(), actorId: randomUUID() }, id = randomUUID();
function request(path: string, body: unknown, from = origin, type = "application/json", query = "") { return new NextRequest(origin + "/api/finance/external-payments/" + path + query,
  { method: "POST", headers: { origin: from, host: "localhost:3194", "content-type": type }, body: JSON.stringify(body) }); }
function privateResponse(response: Response) { expect(response.headers.get("cache-control")).toBe("private, no-store"); expect(response.headers.get("vary")).toBe("Cookie, Origin"); }
describe.each([
  { name: "read", post: read, schema: externalPaymentReadInput, service: boundary.read, input: { operation: "GET", input: { id } } },
  { name: "command", post: command, schema: externalPaymentCommandInput, service: boundary.command, input: { operation: "RECONCILE", input: { id } } },
  { name: "recover", post: recover, schema: externalPaymentRecoveryInput, service: boundary.recover, input: { key: id } },
  { name: "refunds/read", post: refundRead, schema: externalRefundReadInput, service: boundary.refundRead, input: { operation: "GET", input: { intentId: id } } },
  { name: "refunds/command", post: refundCommand, schema: externalRefundCommandInput, service: boundary.refundCommand, input: { operation: "RECONCILE", input: { intentId: id, refundId: "ORIGINAL_REFUND_1" } } },
  { name: "refunds/recover", post: refundRecover, schema: externalRefundRecoveryInput, service: boundary.refundRecover, input: { key: id } },
])("private optional provider $name boundary", ({ name, post, schema, service, input }) => {
  beforeEach(() => { vi.clearAllMocks(); boundary.auth.mockResolvedValue({ user: { id: actor.actorId } }); boundary.actor.mockResolvedValue(actor);
    service.mockImplementation((_actor, raw) => { schema.parse(raw); return Promise.resolve({ privateResult: true }); }); });
  it("uses the authenticated application actor and retains private response headers", async () => {
    const response = await post(request(name, input)); expect(response.status).toBe(200); privateResponse(response); expect(await response.json()).toEqual({ privateResult: true });
    expect(service.mock.calls[0][0]).toBe(actor); expect(service.mock.calls[0][1]).toEqual(input);
  });
  it("rejects unauthenticated or incomplete MFA sessions before consulting the source", async () => {
    boundary.actor.mockResolvedValue(null); const response = await post(request(name, input)); expect(response.status).toBe(401); privateResponse(response); expect(service).not.toHaveBeenCalled();
  });
  it.each([["https://foreign.example", "application/json", "", 403], [origin, "text/plain", "", 403], [origin, "application/json", "?organization=foreign", 400]] as const)("rejects injected boundary state %#", async (from, type, query, status) => {
    const response = await post(request(name, input, from, type, query)); expect(response.status).toBe(status); privateResponse(response); expect(service).not.toHaveBeenCalled();
  });
  it("rejects caller-selected tenant state", async () => {
    const response = await post(request(name, { ...input, organizationId: randomUUID() })); expect(response.status).toBe(400); privateResponse(response);
  });
  it("rejects oversized financial payloads before the application service", async () => {
    const response = await post(request(name, { padding: "x".repeat(5000) })); expect(response.status).toBe(400); privateResponse(response); expect(service).not.toHaveBeenCalled();
  });
  it.each([[new PaymentMethodAccessError(), 403, "forbidden"], [new PaymentMethodChangedError(), 409, "conflict"], [new PaymentMethodConfigurationError(), 409, "configuration_unavailable"], [new PaymentMethodSourceError(), 409, "source_unavailable"]] as const)("returns only a private failure code %#", async (error, status, code) => {
    service.mockRejectedValue(error); const response = await post(request(name, input)); expect(response.status).toBe(status); privateResponse(response); expect(await response.json()).toEqual({ error: code }); expect(boundary.capture).not.toHaveBeenCalled();
  });
});
describe("private original capture status", () => {
  beforeEach(() => { vi.clearAllMocks(); boundary.auth.mockResolvedValue({ user: { id: actor.actorId } }); boundary.actor.mockResolvedValue(actor); boundary.status.mockResolvedValue({ state: "PENDING" }); });
  it("reads the actual route identity with authenticated no-store isolation", async () => {
    const response = await status(new NextRequest(origin + "/api/finance/external-payments/status/" + id), { params: Promise.resolve({ id }) });
    expect(response.status).toBe(200); privateResponse(response); expect(await response.json()).toEqual({ state: "PENDING" }); expect(boundary.status.mock.calls[0].slice(0, 2)).toEqual([actor, { id }]);
  });
  it("rejects a missing MFA session before reading the original provider state", async () => {
    boundary.actor.mockResolvedValue(null); const response = await status(new NextRequest(origin + "/api/finance/external-payments/status/" + id), { params: Promise.resolve({ id }) });
    expect(response.status).toBe(401); privateResponse(response); expect(boundary.status).not.toHaveBeenCalled();
  });
  it("rejects injected tenant or status query state", async () => {
    const response = await status(new NextRequest(origin + "/api/finance/external-payments/status/" + id + "?organization=foreign"), { params: Promise.resolve({ id }) });
    expect(response.status).toBe(400); privateResponse(response); expect(boundary.status).not.toHaveBeenCalled();
  });
  it("withholds a foreign or revoked original source", async () => {
    boundary.status.mockRejectedValue(new PaymentMethodAccessError()); const response = await status(new NextRequest(origin + "/api/finance/external-payments/status/" + id), { params: Promise.resolve({ id }) });
    expect(response.status).toBe(403); privateResponse(response); expect(await response.json()).toEqual({ error: "forbidden" });
  });
});

describe("private original refund status", () => {
  beforeEach(() => { vi.clearAllMocks(); boundary.auth.mockResolvedValue({ user: { id: actor.actorId } }); boundary.actor.mockResolvedValue(actor); boundary.refundStatus.mockResolvedValue({ state: "PENDING" }); });
  it("reads the actual route identity with authenticated no-store isolation", async () => {
    const response = await refundStatus(new NextRequest(origin + "/api/finance/external-payments/refunds/status/" + id), { params: Promise.resolve({ id }) });
    expect(response.status).toBe(200); privateResponse(response); expect(await response.json()).toEqual({ state: "PENDING" }); expect(boundary.refundStatus.mock.calls[0].slice(0, 2)).toEqual([actor, { intentId: id }]);
  });
  it("rejects a missing MFA session before reading the original provider state", async () => {
    boundary.actor.mockResolvedValue(null); const response = await refundStatus(new NextRequest(origin + "/api/finance/external-payments/refunds/status/" + id), { params: Promise.resolve({ id }) });
    expect(response.status).toBe(401); privateResponse(response); expect(boundary.refundStatus).not.toHaveBeenCalled();
  });
  it("rejects injected tenant or status query state", async () => {
    const response = await refundStatus(new NextRequest(origin + "/api/finance/external-payments/refunds/status/" + id + "?organization=foreign"), { params: Promise.resolve({ id }) });
    expect(response.status).toBe(400); privateResponse(response); expect(boundary.refundStatus).not.toHaveBeenCalled();
  });
  it("withholds a foreign or revoked original source", async () => {
    boundary.refundStatus.mockRejectedValue(new PaymentMethodAccessError()); const response = await refundStatus(new NextRequest(origin + "/api/finance/external-payments/refunds/status/" + id), { params: Promise.resolve({ id }) });
    expect(response.status).toBe(403); privateResponse(response); expect(await response.json()).toEqual({ error: "forbidden" });
  });
});
