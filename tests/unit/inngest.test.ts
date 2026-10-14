import { describe, expect, it, vi } from "vitest";
import {
  createInngestOutboxHandlers,
  createInngestOutboxHandler,
  InngestConfigurationError,
  type InngestTransport
} from "@/platform/events/inngest";

const event = {
  id: "018f0a0b-0000-7000-9000-000000000011",
  organizationId: "018f0a0b-0000-7000-9000-000000000001",
  type: "reservation.created",
  payload: { reservationId: "018f0a0b-0000-7000-9000-000000000101" },
  status: "PENDING",
  idempotencyKey: "reservation-created-101",
  occurredAt: new Date("2026-10-11T00:00:00.000Z"),
  processedAt: null,
  attemptCount: 0,
  nextAttemptAt: null,
  lastError: null,
  createdAt: new Date("2026-10-11T00:00:00.000Z"),
  updatedAt: new Date("2026-10-11T00:00:00.000Z")
};

describe("Inngest outbox forwarding", () => {
  it("requires an event key", () => {
    expect(() => createInngestOutboxHandler({})).toThrow(InngestConfigurationError);
  });

  it("posts outbox events to the Inngest Event API", async () => {
    const transport = vi.fn<InngestTransport>(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ ids: ["evt_1"], status: 200 }),
        text: () => Promise.resolve("")
      })
    );
    const handler = createInngestOutboxHandler(
      {
        INNGEST_EVENT_KEY: "event-key",
        INNGEST_EVENT_URL: "https://inn.gs",
        INNGEST_ENV: "staging"
      },
      transport
    );

    await expect(handler(event)).resolves.toEqual({ ids: ["evt_1"], status: 200 });
    expect(transport).toHaveBeenCalledWith(
      "https://inn.gs/e/event-key",
      expect.objectContaining({
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-inngest-env": "staging"
        }
      })
    );
    const transportCalls = transport.mock.calls;
    const transportCall = transportCalls[0];

    expect(transportCall).toBeDefined();
    expect(JSON.parse(transportCall?.[1].body)).toMatchObject({
      id: "reservation.created:reservation-created-101",
      name: "reservation.created",
      data: {
        organizationId: event.organizationId,
        outboxEventId: event.id,
        reservationId: "018f0a0b-0000-7000-9000-000000000101"
      },
      ts: new Date("2026-10-11T00:00:00.000Z").getTime()
    });
  });

  it("creates a wildcard outbox handler for every event type", async () => {
    const transport = vi.fn<InngestTransport>(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ ids: ["evt_1"], status: 200 }),
        text: () => Promise.resolve("")
      })
    );
    const handlers = createInngestOutboxHandlers({ INNGEST_EVENT_KEY: "event-key" }, transport);

    await expect(handlers["*"]?.(event)).resolves.toBeUndefined();
    expect(transport).toHaveBeenCalledOnce();
  });
});
