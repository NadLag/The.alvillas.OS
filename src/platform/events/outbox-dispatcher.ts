import type { OutboxEvent as PrismaOutboxEvent } from "@prisma/client";
import { withTenant, type TenantTransactionRunner } from "@/platform/db/tenant";

export type OutboxHandler = (event: PrismaOutboxEvent) => Promise<void>;

export type OutboxHandlers = Record<string, OutboxHandler>;

export type DispatchOutboxResult = {
  dispatched: number;
  failed: number;
  skipped: number;
};

export async function dispatchOutboxBatch(
  db: TenantTransactionRunner,
  organizationId: string,
  handlers: OutboxHandlers,
  options: { limit?: number; now?: Date } = {}
): Promise<DispatchOutboxResult> {
  const limit = options.limit ?? 50;

  if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
    throw new Error("outbox dispatch limit must be an integer between 1 and 500");
  }

  return withTenant(db, organizationId, async (tx) => {
    const events = await tx.outboxEvent.findMany({
      where: { organizationId, status: "PENDING" },
      orderBy: { occurredAt: "asc" },
      take: limit
    });
    const result: DispatchOutboxResult = { dispatched: 0, failed: 0, skipped: 0 };

    for (const event of events) {
      const handler = handlers[event.type];
      const processedAt = options.now ?? new Date();

      if (!handler) {
        await tx.outboxEvent.update({
          where: { id: event.id },
          data: { status: "FAILED", processedAt }
        });
        result.skipped += 1;
        continue;
      }

      try {
        await handler(event);
        await tx.outboxEvent.update({
          where: { id: event.id },
          data: { status: "DISPATCHED", processedAt }
        });
        result.dispatched += 1;
      } catch {
        await tx.outboxEvent.update({
          where: { id: event.id },
          data: { status: "FAILED", processedAt }
        });
        result.failed += 1;
      }
    }

    return result;
  });
}
