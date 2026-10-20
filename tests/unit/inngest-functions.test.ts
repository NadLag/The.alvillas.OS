import { automationEvents } from "@/platform/automation/events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { NonRetriableError } from "inngest";
import { createHmac } from "node:crypto";
import { consumeAutomations, dispatchOutbox, dispatchRequestOrganization, inngestFunctions, outboxDispatchEvent } from "@/platform/events/inngest-functions";
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
    expect(inngestFunctions).toHaveLength(6);
    for(const consumer of consumeAutomations) expect(consumer.opts.triggers!.length).toBeLessThanOrEqual(10);
    expect(consumeAutomations.flatMap(consumer=>consumer.opts.triggers!.map(trigger=>"event" in trigger?trigger.event:undefined))).toEqual([...automationEvents]);
    expect(dispatchOutbox.opts.triggers).toEqual([{ cron: "* * * * *" }, { event: outboxDispatchEvent }]);
    expect(dispatchOutbox.opts.concurrency).toEqual({ limit: 1 });
  });

  it("syncs recurring recovery without an event-id admission limit because timer events have no id", async () => {
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
    const registration = await response.json() as { functions: Array<{ idempotency?: string; rateLimit?: unknown; steps: { step: { retries: { attempts: number } } } }> };
    expect(registration.functions).toHaveLength(6);
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
    const body = await discovery.json() as { function_count: number }; expect(body.function_count).toBe(6);
    expect(JSON.stringify(body)).not.toContain(process.env.INNGEST_SIGNING_KEY!);
    const execution = await POST(new NextRequest("http://localhost:3000/api/inngest?fnId=alvillas-os-dispatch-outbox&stepId=step", { method: "POST", body: "{}" }), {});
    expect(execution.status).toBe(401);
    const expired = await GET(new NextRequest("http://localhost:3000/api/inngest", { headers: signature("", Math.floor(Date.now() / 1000) - 600) }), {});
    expect(expired.status).toBe(401);
    const tampered = await POST(new NextRequest("http://localhost:3000/api/inngest?fnId=alvillas-os-dispatch-outbox&stepId=step", { method: "POST", body: '{"forged":true}', headers: signature("{}") }), {});
    expect(tampered.status).toBe(401);
  });
});
