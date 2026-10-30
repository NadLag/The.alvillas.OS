import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SupplierInvoiceAccessError } from "@/modules/finance/application/supplier-invoice-access";

const boundary = vi.hoisted(() => ({ auth: vi.fn(), actor: vi.fn(), request: vi.fn(), status: vi.fn(), revalidate: vi.fn(), capture: vi.fn() }));
vi.mock("@/platform/auth/session", () => ({ auth: boundary.auth }));
vi.mock("@/modules/finance/application/finance-access", () => ({ financeActorContextFromSession: boundary.actor }));
vi.mock("@/modules/finance/application/supplier-invoice-recognition-requests", () => ({ requestSupplierInvoiceReversal: boundary.request }));
vi.mock("@/modules/finance/application/supplier-invoice-reversal-status", () => ({ getSupplierInvoiceReversalStatus: boundary.status }));
vi.mock("next/cache", () => ({ revalidatePath: boundary.revalidate }));
vi.mock("@/platform/observability/sentry", () => ({ captureException: boundary.capture }));
import { requestSupplierInvoiceReversalAction } from "@/modules/finance/application/supplier-invoice-reversal-actions";

const input = () => ({ id: randomUUID(), expectedVersion: 2, idempotencyKey: randomUUID(), reason: "Explicit complete original cost cancellation" });
beforeEach(() => { vi.resetAllMocks(); boundary.auth.mockResolvedValue({}); boundary.actor.mockResolvedValue({ organizationId: randomUUID(), actorId: randomUUID() }); boundary.capture.mockResolvedValue(undefined); });
describe("supplier claim reversal action boundary", () => {
  it("denies admission without the independently verified financial session", async () => {
    boundary.actor.mockResolvedValue(null);
    expect(await requestSupplierInvoiceReversalAction({ input: input(), confirmed: true })).toEqual({ ok: false, code: "forbidden" });
    expect(boundary.request).not.toHaveBeenCalled();
  });
  it("requires explicit whole-claim confirmation before durable admission", async () => {
    expect(await requestSupplierInvoiceReversalAction({ input: input(), confirmed: false })).toEqual({ ok: false, code: "validation" });
    expect(boundary.request).not.toHaveBeenCalled(); expect(boundary.revalidate).not.toHaveBeenCalled();
  });
  it.each([new RangeError("Controlled post-commit response failure"), new SupplierInvoiceAccessError()])("preserves an uncertain acknowledgement after successful admission and failed route revalidation (%s)", async error => {
    boundary.request.mockResolvedValue({ requestId: randomUUID(), state: "PENDING", idempotent: false });
    boundary.revalidate.mockImplementation(() => { throw error; });
    expect(await requestSupplierInvoiceReversalAction({ input: input(), confirmed: true })).toEqual({ ok: false, code: "error" });
    expect(boundary.request).toHaveBeenCalledTimes(1); expect(boundary.capture).toHaveBeenCalledTimes(1);
  });
});
