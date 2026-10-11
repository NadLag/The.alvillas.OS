import { describe, expect, it, vi } from "vitest";
import { dispatchOutboxBatch } from "@/platform/events/outbox-dispatcher";
import type { TenantTransaction, TenantTransactionRunner } from "@/platform/db/tenant";

const organizationId = "018f0a0b-0000-7000-9000-000000000001";

function outboxEvent(id: string, type: string) {
  return {
    id,
    organizationId,
    type,
    payload: {},
    status: "PENDING",
    idempotencyKey: id,
    occurredAt: new Date("2026-10-11T00:00:00.000Z"),
    processedAt: null,
    createdAt: new Date("2026-10-11T00:00:00.000Z"),
    updatedAt: new Date("2026-10-11T00:00:00.000Z")
  };
}

function runner(events: ReturnType<typeof outboxEvent>[]): {
  db: TenantTransactionRunner;
  update: ReturnType<typeof vi.fn>;
} {
  const update = vi.fn(() => Promise.resolve({}));
  const tx = {
    $executeRaw: vi.fn(() => Promise.resolve(1)),
    outboxEvent: {
      findMany: vi.fn(() => Promise.resolve(events)),
      update
    }
  };

  const db: TenantTransactionRunner = {
    $transaction: (callback) => callback(tx as unknown as TenantTransaction)
  };

  return { db, update };
}

describe("dispatchOutboxBatch", () => {
  it("dispatches pending events through registered handlers", async () => {
    const { db, update } = runner([outboxEvent("evt-1", "reservation.created")]);
    const handler = vi.fn(() => Promise.resolve());

    await expect(
      dispatchOutboxBatch(
        db,
        organizationId,
        { "reservation.created": handler },
        { now: new Date("2026-10-11T01:00:00.000Z") }
      )
    ).resolves.toEqual({ dispatched: 1, failed: 0, skipped: 0 });

    expect(handler).toHaveBeenCalledOnce();
    expect(update).toHaveBeenCalledWith({
      where: { id: "evt-1" },
      data: { status: "DISPATCHED", processedAt: new Date("2026-10-11T01:00:00.000Z") }
    });
  });

  it("marks events failed when no handler is registered", async () => {
    const { db } = runner([outboxEvent("evt-1", "missing")]);

    await expect(dispatchOutboxBatch(db, organizationId, {})).resolves.toMatchObject({
      dispatched: 0,
      failed: 0,
      skipped: 1
    });
  });

  it("marks events failed when handlers throw", async () => {
    const { db } = runner([outboxEvent("evt-1", "reservation.created")]);

    await expect(
      dispatchOutboxBatch(db, organizationId, {
        "reservation.created": vi.fn(() => Promise.reject(new Error("boom")))
      })
    ).resolves.toMatchObject({ dispatched: 0, failed: 1, skipped: 0 });
  });
});
