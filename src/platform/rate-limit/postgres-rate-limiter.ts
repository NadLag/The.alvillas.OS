import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import type { RateLimiter } from "@/platform/providers";
import { withTenant, type TenantTransactionRunner } from "@/platform/db/tenant";

type RateLimitRow = {
  count: number;
  window_start: Date;
};

export type RateLimitClient = {
  $queryRaw(query: Prisma.Sql): Promise<RateLimitRow[]>;
};

export type RateLimitInput = {
  key: string;
  limit: number;
  windowSeconds: number;
  now?: Date;
};

export type RateLimitDecision = {
  allowed: boolean;
  remaining: number;
  resetAt: Date;
};

export function hashRateLimitKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

export function rateLimitWindowStart(now: Date, windowSeconds: number): Date {
  if (!Number.isInteger(windowSeconds) || windowSeconds <= 0) {
    throw new Error("windowSeconds must be a positive integer");
  }

  return new Date(Math.floor(now.getTime() / (windowSeconds * 1000)) * windowSeconds * 1000);
}

export async function consumeRateLimit(
  client: RateLimitClient,
  organizationId: string,
  input: RateLimitInput
): Promise<RateLimitDecision> {
  if (!Number.isInteger(input.limit) || input.limit <= 0) {
    throw new Error("limit must be a positive integer");
  }

  const now = input.now ?? new Date();
  const windowStart = rateLimitWindowStart(now, input.windowSeconds);
  const rows = await client.$queryRaw(
    Prisma.sql`
      INSERT INTO rate_limit_bucket (
        organization_id,
        key_hash,
        window_start,
        window_seconds,
        count
      )
      VALUES (
        ${organizationId}::uuid,
        ${hashRateLimitKey(input.key)},
        ${windowStart},
        ${input.windowSeconds},
        1
      )
      ON CONFLICT (
        organization_id,
        key_hash,
        window_start,
        window_seconds
      )
      DO UPDATE SET
        count = rate_limit_bucket.count + 1,
        updated_at = now()
      RETURNING count, window_start
    `
  );
  const row = rows[0];

  if (!row) {
    throw new Error("rate limit consume returned no row");
  }

  const remaining = Math.max(input.limit - row.count, 0);

  return {
    allowed: row.count <= input.limit,
    remaining,
    resetAt: new Date(row.window_start.getTime() + input.windowSeconds * 1000)
  };
}

export class PostgresRateLimiter implements RateLimiter {
  constructor(
    private readonly db: TenantTransactionRunner,
    private readonly organizationId: string
  ) {}

  consume(input: RateLimitInput): Promise<RateLimitDecision> {
    return withTenant(this.db, this.organizationId, async (tx) =>
      consumeRateLimit(tx as unknown as RateLimitClient, this.organizationId, input)
    );
  }
}
