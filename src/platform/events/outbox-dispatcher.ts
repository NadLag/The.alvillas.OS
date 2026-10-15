import type { OutboxEvent as PrismaOutboxEvent } from "@prisma/client";
import { withTenant, type TenantTransactionRunner } from "@/platform/db/tenant";
import { captureException } from "@/platform/observability/sentry";
import { logger } from "@/platform/observability/logger";
import { OutboxRepository, type OutboxDatabase } from "./outbox-repository";

export type OutboxHandler = (event: PrismaOutboxEvent) => Promise<void>;

export type OutboxHandlers = Record<string, OutboxHandler>;

// A consumer may commit durable per-device diagnostics before asking the shared
// dispatcher to retry its source. Messages must contain only safe error codes.
export class OutboxRetryError extends Error {
  constructor(message: string, readonly nextAttemptAt: Date | null, readonly exhausted = false) { super(message); }
}

export type DispatchOutboxResult = {
  dispatched: number;
  failed: number;
  skipped: number;
};

export type OutboxErrorReporter = (error: unknown, event: PrismaOutboxEvent) => Promise<void>;

type OutboxRetryOptions = {
  maxAttempts?: number;
  backoffSeconds?: number;
};

function retryAt(now: Date, attemptCount: number, backoffSeconds: number): Date {
  return new Date(now.getTime() + Math.max(1, attemptCount) * backoffSeconds * 1000);
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message.slice(0, 2000);
  }

  return String(error).slice(0, 2000);
}

function handlerFor(handlers: OutboxHandlers, eventType: string): OutboxHandler | undefined {
  return handlers[eventType] ?? handlers["*"];
}

export async function dispatchOutboxBatch(
  db: TenantTransactionRunner,
  organizationId: string,
  handlers: OutboxHandlers,
  options: {
    limit?: number;
    now?: Date;
    errorReporter?: OutboxErrorReporter;
    retry?: OutboxRetryOptions;
  } = {}
): Promise<DispatchOutboxResult> {
  const limit = options.limit ?? 50;
  const maxAttempts = options.retry?.maxAttempts ?? 5;
  const backoffSeconds = options.retry?.backoffSeconds ?? 60;
  const errorReporter =
    options.errorReporter ??
    (async (error: unknown, event: PrismaOutboxEvent) => {
      await captureException(error, {
        source: "outbox",
        organizationId: event.organizationId,
        jobId: event.id,
        tags: { eventType: event.type },
        extra: {
          idempotencyKey: event.idempotencyKey,
          occurredAt: event.occurredAt.toISOString()
        }
      });
    });

  if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
    throw new Error("outbox dispatch limit must be an integer between 1 and 500");
  }

  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 25) {
    throw new Error("outbox maxAttempts must be an integer between 1 and 25");
  }

  if (!Number.isInteger(backoffSeconds) || backoffSeconds < 1 || backoffSeconds > 3600) {
    throw new Error("outbox backoffSeconds must be an integer between 1 and 3600");
  }

  return withTenant(db, organizationId, async (tx) => {
    const repository = new OutboxRepository(tx, organizationId);
    await repository.lockDispatcher();
    const now = options.now ?? new Date();
    const events = await repository.due(now, limit);
    const result: DispatchOutboxResult = { dispatched: 0, failed: 0, skipped: 0 };

    for (const event of events) {
      const handler = handlerFor(handlers, event.type);
      const processedAt = options.now ?? new Date();

      if (!handler) {
        await repository.update(event.id, {
            status: "FAILED",
            processedAt,
            attemptCount: { increment: 1 },
            nextAttemptAt: null,
            lastError: `No outbox handler registered for ${event.type}`
        });
        result.skipped += 1;
        continue;
      }

      try {
        await handler(event);
        await repository.update(event.id, {
            status: "DISPATCHED",
            processedAt,
            nextAttemptAt: null,
            lastError: null
        });
        result.dispatched += 1;
      } catch (error) {
        const nextAttemptCount = event.attemptCount + 1;
        const exhausted = error instanceof OutboxRetryError ? error.exhausted : nextAttemptCount >= maxAttempts;
        logger.error(
          "outbox dispatch failed",
          { organizationId, jobId: event.id },
          { eventType: event.type, idempotencyKey: event.idempotencyKey, error }
        );
        await errorReporter(error, event);
        await repository.update(event.id, {
            status: exhausted ? "FAILED" : "PENDING",
            processedAt,
            attemptCount: { increment: 1 },
            nextAttemptAt: exhausted ? null : error instanceof OutboxRetryError ? error.nextAttemptAt : retryAt(processedAt, nextAttemptCount, backoffSeconds),
            lastError: errorMessage(error)
        });
        result.failed += 1;
      }
    }

    return result;
  });
}

export async function dispatchOutboxForAllOrganizations(
  db: OutboxDatabase,
  handlers: OutboxHandlers,
  options: {
    limitPerOrganization?: number;
    now?: Date;
    errorReporter?: OutboxErrorReporter;
    retry?: OutboxRetryOptions;
  } = {}
): Promise<DispatchOutboxResult & { organizations: number }> {
  const organizations = await OutboxRepository.organizations(db);
  const total = {
    organizations: organizations.length,
    dispatched: 0,
    failed: 0,
    skipped: 0
  };

  for (const organization of organizations) {
    const result = await dispatchOutboxBatch(db, organization.id, handlers, {
      limit: options.limitPerOrganization,
      now: options.now,
      errorReporter: options.errorReporter,
      retry: options.retry
    });
    total.dispatched += result.dispatched;
    total.failed += result.failed;
    total.skipped += result.skipped;
  }

  return total;
}
