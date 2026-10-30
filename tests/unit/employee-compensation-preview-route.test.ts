import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { ZodError } from "zod";
import { EmployeeCompensationAccessError, EmployeeCompensationSourceUnavailableError } from "@/modules/finance/application/employee-compensation-service";
import { EmployeeCompensationBasisError } from "@/modules/finance/domain/employee-compensation";

const boundary = vi.hoisted(() => ({ auth: vi.fn(), actor: vi.fn(), work: vi.fn(), capture: vi.fn() }));
vi.mock("@/platform/auth/session", () => ({ auth: boundary.auth }));
vi.mock("@/modules/finance/application/finance-access", () => ({ financeActorContextFromSession: boundary.actor }));
vi.mock("@/modules/finance/application/employee-compensation-preview-request", () => ({ previewEmployeeCompensationRequest: boundary.work }));
vi.mock("@/platform/observability/sentry", () => ({ captureException: boundary.capture }));
import { POST } from "@/app/api/finance/compensation/preview/route";

const actor = { organizationId: "00000000-0000-4000-8000-000000000001", actorId: "00000000-0000-4000-8000-000000000002" };
const request = (body = "{}", headers: Record<string, string> = {}) => new NextRequest("http://127.0.0.1:3134/api/finance/compensation/preview", {
  method: "POST", body, headers: { host: "localhost:3134", origin: "http://localhost:3134", "content-type": "application/json", ...headers }
});
describe("private employee compensation preview HTTP boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks(); boundary.auth.mockResolvedValue({ user: { id: actor.actorId } }); boundary.actor.mockResolvedValue(actor);
    boundary.work.mockResolvedValue({ kind: "CONTRACTUAL_ESTIMATE", amount: { amount: "500.25", currency: "MAD" } }); boundary.capture.mockResolvedValue(undefined);
  });
  it("requires an authenticated finance actor before reading compensation", async () => {
    boundary.actor.mockResolvedValue(null);
    const response = await POST(request());
    expect(response.status).toBe(401); expect(await response.json()).toEqual({ error: "unauthorized" }); expect(boundary.work).not.toHaveBeenCalled();
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });
  it.each([["origin", "https://foreign.example"], ["origin", ""], ["content-type", "text/plain"]])("rejects an unsafe request %# before business reads", async (header, value) => {
    const response = await POST(request("{}", { [header]: value }));
    expect(response.status).toBe(403); expect(await response.json()).toEqual({ error: "forbidden" }); expect(boundary.work).not.toHaveBeenCalled();
  });
  it.each(["{", '"' + "x".repeat(65536) + '"'])("bounds and validates JSON before dispatch %#", async body => {
    const response = await POST(request(body));
    expect(response.status).toBe(400); expect(await response.json()).toEqual({ error: "validation" }); expect(boundary.work).not.toHaveBeenCalled();
  });
  it("uses the authenticated actor and a server-generated audit identifier", async () => {
    const input = { kind: "contract", input: { assignmentId: actor.actorId, earnedAt: "2026-10-30T00:00:00Z", basis: { mode: "PER_JOB", jobs: "1" } } },
      response = await POST(request(JSON.stringify(input), { "x-request-id": "untrusted-client-value" }));
    expect(response.status).toBe(200); expect(await response.json()).toMatchObject({ amount: { amount: "500.25" } });
    expect(boundary.work).toHaveBeenCalledWith(actor, input, expect.stringMatching(/^[0-9a-f-]{36}$/u));
    expect(response.headers.get("cache-control")).toBe("private, no-store"); expect(response.headers.get("vary")).toBe("Cookie, Origin");
  });
  it.each([
    [new EmployeeCompensationAccessError(), 403, "forbidden"], [new EmployeeCompensationSourceUnavailableError(), 409, "source_unavailable"],
    [new EmployeeCompensationBasisError(), 400, "validation"], [new ZodError([]), 400, "validation"], [new Error("private compensation internals"), 503, "unavailable"]
  ] as const)("returns a private error response %# without echoing source data", async (error, status, code) => {
    boundary.work.mockRejectedValue(error); const response = await POST(request());
    expect(response.status).toBe(status); expect(await response.json()).toEqual({ error: code });
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });
});
