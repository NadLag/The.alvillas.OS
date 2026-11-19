import { describe, expect, it, vi } from "vitest";
import { logger } from "@/platform/observability/logger";
import {
  dispatchOutboxBatch,
  dispatchOutboxForAllOrganizations
} from "@/platform/events/outbox-dispatcher";
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
    attemptCount: 0,
    nextAttemptAt: null,
    lastError: null,
    createdAt: new Date("2026-10-11T00:00:00.000Z"),
    updatedAt: new Date("2026-10-11T00:00:00.000Z")
  };
}

function runner(events: ReturnType<typeof outboxEvent>[], organizations = [{ id: organizationId }]): {
  db: TenantTransactionRunner & {
    organization: {
      findMany: ReturnType<typeof vi.fn>;
    };
  };
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

  const db: TenantTransactionRunner & {
    organization: { findMany: ReturnType<typeof vi.fn> };
  } = {
    organization: {
      findMany: vi.fn(() => Promise.resolve(organizations))
    },
    $transaction: (callback) => callback(tx as unknown as TenantTransaction)
  };

  return { db, update };
}

describe("dispatchOutboxBatch", () => {
  it("publishes committed lag and batch outcomes without event identifiers", async () => {
    const { db } = runner([outboxEvent("private-event", "reservation.created")]);
    const originalTransaction = db.$transaction;
    let committed = false;
    db.$transaction = async (callback) => {
      const result = await originalTransaction(callback);
      committed = true;
      return result;
    };
    const info = vi.spyOn(logger, "info").mockImplementation(() => {
      expect(committed).toBe(true);
    });
    try {
      await dispatchOutboxBatch(db, organizationId, { "reservation.created": async () => {} }, {
        now: new Date("2026-10-11T00:00:42.000Z"), limit: 1
      });
      expect(info).toHaveBeenCalledExactlyOnceWith("outbox.batch.committed", { organizationId }, {
        dispatched: 1, failed: 0, skipped: 0, selected: 1, oldestDueMs: 42_000, atCapacity: true
      });
    } finally {
      info.mockRestore();
    }
  });

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
      where: { id: "evt-1", organizationId },
      data: {
        status: "DISPATCHED",
        processedAt: new Date("2026-10-11T01:00:00.000Z"),
        nextAttemptAt: null,
        lastError: null
      }
    });
  });

  it("dispatches unknown event types through the wildcard Inngest handler", async () => {
    const { db, update } = runner([outboxEvent("evt-1", "reservation.created")]);
    const handler = vi.fn(() => Promise.resolve());

    await expect(
      dispatchOutboxBatch(db, organizationId, { "*": handler }, { now: new Date("2026-10-11T01:00:00.000Z") })
    ).resolves.toEqual({ dispatched: 1, failed: 0, skipped: 0 });

    expect(handler).toHaveBeenCalledOnce();
    const updateArgs = update.mock.calls[0]?.[0] as
      | { where?: { id?: string }; data?: { status?: string } }
      | undefined;

    expect(updateArgs?.where?.id).toBe("evt-1");
    expect(updateArgs?.data?.status).toBe("DISPATCHED");
  });

  it("marks events failed when no handler is registered", async () => {
    const { db, update } = runner([outboxEvent("evt-1", "missing")]);

    await expect(dispatchOutboxBatch(db, organizationId, {})).resolves.toMatchObject({
      dispatched: 0,
      failed: 0,
      skipped: 1
    });
    const updateArgs = update.mock.calls[0]?.[0] as
      | {
          where?: { id?: string };
          data?: { status?: string; attemptCount?: { increment?: number }; lastError?: string };
        }
      | undefined;

    expect(updateArgs?.where?.id).toBe("evt-1");
    expect(updateArgs?.data).toMatchObject({
      status: "FAILED",
      attemptCount: { increment: 1 },
      lastError: "No outbox handler registered for missing"
    });
  });

  it("keeps failed events pending until retry attempts are exhausted", async () => {
    const { db, update } = runner([outboxEvent("evt-1", "reservation.created")]);
    const errorReporter = vi.fn(() => Promise.resolve());

    await expect(
      dispatchOutboxBatch(
        db,
        organizationId,
        {
          "reservation.created": vi.fn(() => Promise.reject(new Error("boom")))
        },
        {
          errorReporter,
          now: new Date("2026-10-11T01:00:00.000Z"),
          retry: { maxAttempts: 3, backoffSeconds: 30 }
        }
      )
    ).resolves.toMatchObject({ dispatched: 0, failed: 1, skipped: 0 });
    expect(errorReporter).toHaveBeenCalledOnce();
    const updateArgs = update.mock.calls[0]?.[0] as
      | {
          where?: { id?: string };
          data?: {
            status?: string;
            attemptCount?: { increment?: number };
            nextAttemptAt?: Date;
            lastError?: string;
          };
        }
      | undefined;

    expect(updateArgs?.where?.id).toBe("evt-1");
    expect(updateArgs?.data).toMatchObject({
      status: "PENDING",
      attemptCount: { increment: 1 },
      nextAttemptAt: new Date("2026-10-11T01:00:30.000Z"),
      lastError: "boom"
    });
  });

  it("marks events failed after the final retry attempt", async () => {
    const event = { ...outboxEvent("evt-1", "reservation.created"), attemptCount: 2 };
    const { db, update } = runner([event]);

    await expect(
      dispatchOutboxBatch(
        db,
        organizationId,
        { "reservation.created": vi.fn(() => Promise.reject(new Error("boom"))) },
        {
          errorReporter: vi.fn(() => Promise.resolve()),
          now: new Date("2026-10-11T01:00:00.000Z"),
          retry: { maxAttempts: 3, backoffSeconds: 30 }
        }
      )
    ).resolves.toMatchObject({ dispatched: 0, failed: 1, skipped: 0 });
    const updateArgs = update.mock.calls[0]?.[0] as
      | {
          where?: { id?: string };
          data?: { status?: string; nextAttemptAt?: Date | null; lastError?: string };
        }
      | undefined;

    expect(updateArgs?.where?.id).toBe("evt-1");
    expect(updateArgs?.data).toMatchObject({
      status: "FAILED",
      nextAttemptAt: null,
      lastError: "boom"
    });
  });

  it("dispatches tenant-scoped batches for every organization", async () => {
    const organizationB = "018f0a0b-0000-7000-9000-000000000002";
    const { db } = runner([outboxEvent("evt-1", "reservation.created")], [
      { id: organizationId },
      { id: organizationB }
    ]);

    await expect(
      dispatchOutboxForAllOrganizations(db as never, {
        "reservation.created": vi.fn(() => Promise.resolve())
      })
    ).resolves.toMatchObject({
      organizations: 2,
      dispatched: 2
    });
  });
});
