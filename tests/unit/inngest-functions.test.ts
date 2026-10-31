import { automationEvents } from "@/platform/automation/events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { NonRetriableError } from "inngest";
import { createHmac } from "node:crypto";
import { cleanupUploadParts, consumeAutomations, dispatchOutbox, dispatchRequestOrganization, inngestFunctions, outboxDispatchEvent, recognizeSupplierInvoices, failSupplierInvoiceRecognitions } from "@/platform/events/inngest-functions";
import type { OutboxDatabase } from "@/platform/events/outbox-repository";

const organizationId = "018f0a0b-0000-7000-9000-000000000001";
const outboxEventId = "018f0a0b-0000-7000-9000-000000000011";
function database(found: object | null) {
  const findFirst = vi.fn(() => Promise.resolve(found));
  const tx = { $executeRaw: vi.fn(() => Promise.resolve(1)), outboxEvent: { findFirst } };
  return { db: { $transaction: (work: (value: unknown) => unknown) => Promise.resolve(work(tx)) } as unknown as OutboxDatabase, findFirst };
}
afterEach(() => vi.unstubAllEnvs());

describe("Inngest signed outbox dispatcher", () => {
  it("registers the dispatcher and durable automation consumer", () => {
    expect(inngestFunctions).toHaveLength(9);
    expect(recognizeSupplierInvoices.opts.triggers).toEqual([{ event: "SupplierInvoiceRecognitionRequested" }, { event: "SupplierInvoiceReversalRequested" },{event:"EmployeeCompensationSubmissionRequested"},{event:"EmployeeCompensationRecognitionRequested"},{event:"EmployeeMonthlyRunRequested"}]);
    expect(recognizeSupplierInvoices.opts.concurrency).toEqual({ limit: 1 });
    expect(recognizeSupplierInvoices.opts.retries).toBe(3);
    expect(failSupplierInvoiceRecognitions.opts.triggers).toEqual([{ event: "inngest/function.failed", if: "event.data.function_id == 'alvillas-os-supplier-invoice-recognition'" }]);
    expect(failSupplierInvoiceRecognitions.opts.concurrency).toEqual({ limit: 1 });
    expect(failSupplierInvoiceRecognitions.opts.retries).toBe(3);
    for(const consumer of consumeAutomations) expect(consumer.opts.triggers!.length).toBeLessThanOrEqual(10);
    expect(consumeAutomations.flatMap(consumer=>consumer.opts.triggers!.map(trigger=>"event" in trigger?trigger.event:undefined))).toEqual([...automationEvents]);
    expect(dispatchOutbox.opts.triggers).toEqual([{ cron: "* * * * *" }, { event: outboxDispatchEvent }]);
    expect(dispatchOutbox.opts.concurrency).toEqual({ limit: 1 });
    expect(cleanupUploadParts.opts.triggers).toEqual([{ cron: "* * * * *" }]);
    expect(cleanupUploadParts.opts.concurrency).toEqual({ limit: 1 });
    expect(cleanupUploadParts.opts.retries).toBe(3);
  });

  it("registers recurring recovery and automation consumers within staging concurrency limits", async () => {
    vi.stubEnv("INNGEST_SIGNING_KEY", `signkey-test-${"1".repeat(64)}`);
    const { PUT } = await import("@/app/api/inngest/route");
    const url = "http://localhost:3000/api/inngest";
    const body = JSON.stringify({ url });
    const seconds = String(Math.floor(Date.now() / 1000));
    const digest = createHmac("sha256", "1".repeat(64)).update(body).update(seconds).digest("hex");
    const response = await PUT(new NextRequest(url, { method: "PUT", body, headers: {
      "content-type": "application/json", "x-inngest-sync-kind": "in_band", "x-inngest-signature": `t=${seconds}&s=${digest}`
    } }), {});
    expect(response.status).toBe(200);
    const registration = await response.json() as { functions: Array<{ idempotency?: string; rateLimit?: unknown; concurrency?: { limit: number } | Array<{ limit: number }>; steps: { step: { retries: { attempts: number } } } }> };
    // The terminal-failure consumer has its own explicit concurrency limit.
    expect(registration.functions).toHaveLength(9);
    // Cloud validates each emitted function against the existing staging plan.
    // Rejecting one consumer prevents synchronization of the whole application.
    for (const fn of registration.functions) {
      const limits = Array.isArray(fn.concurrency) ? fn.concurrency : [fn.concurrency];
      expect(limits.length).toBeGreaterThan(0);
      for (const limit of limits) {
        expect(limit?.limit).toBeGreaterThan(0);
        expect(limit?.limit).toBeLessThanOrEqual(5);
      }
    }
    expect(registration.functions[0].idempotency).toBeUndefined();
    expect(registration.functions[0].rateLimit).toBeUndefined();
    expect(registration.functions[0].steps.step.retries.attempts).toBe(3);
  });

  it("loads the canonical reference under the claimed tenant", async () => {
    const { db, findFirst } = database({ id: outboxEventId, organizationId, type: outboxDispatchEvent, status: "DISPATCHED" });
    await expect(dispatchRequestOrganization({ organizationId, outboxEventId }, db)).resolves.toBe(organizationId);
    expect(findFirst).toHaveBeenCalledWith({ where: { organizationId, id: outboxEventId } });
  });

  it("denies missing, forged, terminal and non-dispatch event references", async () => {
    for (const found of [null, { type: "notification.requested", status: "PENDING" }, { type: outboxDispatchEvent, status: "FAILED" }]) {
      await expect(dispatchRequestOrganization({ organizationId, outboxEventId }, database(found).db)).rejects.toBeInstanceOf(NonRetriableError);
    }
    const { db, findFirst } = database(null);
    await expect(dispatchRequestOrganization({ organizationId, outboxEventId, payload: "untrusted" }, db)).rejects.toBeInstanceOf(NonRetriableError);
    expect(findFirst).not.toHaveBeenCalled();
  });

  it("authenticates discovery and rejects unsigned, tampered and expired requests through the real SDK", async () => {
    vi.stubEnv("INNGEST_SIGNING_KEY", `signkey-test-${"1".repeat(64)}`);
    const { GET, POST } = await import("@/app/api/inngest/route");
    const signature = (body: string, seconds = Math.floor(Date.now() / 1000)) => {
      const digest = createHmac("sha256", "1".repeat(64)).update(body).update(String(seconds)).digest("hex");
      return { "x-inngest-signature": `t=${seconds}&s=${digest}` };
    };
    expect((await GET(new NextRequest("http://localhost:3000/api/inngest"), {})).status).toBe(401);
    const discovery = await GET(new NextRequest("http://localhost:3000/api/inngest", { headers: signature("") }), {});
    expect(discovery.status).toBe(200);
    const body = await discovery.json() as { function_count: number }; expect(body.function_count).toBe(9);
    expect(JSON.stringify(body)).not.toContain(process.env.INNGEST_SIGNING_KEY!);
    const execution = await POST(new NextRequest("http://localhost:3000/api/inngest?fnId=alvillas-os-dispatch-outbox&stepId=step", { method: "POST", body: "{}" }), {});
    expect(execution.status).toBe(401);
    const expired = await GET(new NextRequest("http://localhost:3000/api/inngest", { headers: signature("", Math.floor(Date.now() / 1000) - 600) }), {});
    expect(expired.status).toBe(401);
    const tampered = await POST(new NextRequest("http://localhost:3000/api/inngest?fnId=alvillas-os-dispatch-outbox&stepId=step", { method: "POST", body: '{"forged":true}', headers: signature("{}") }), {});
    expect(tampered.status).toBe(401);
  });
});
