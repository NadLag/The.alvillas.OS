import { prisma } from "@/platform/db/client";
import { withTenant, type TenantTransactionRunner } from "@/platform/db/tenant";
import { bootstrapOrganizationId } from "@/platform/identity/bootstrap";
import {
  consumeRateLimit,
  type RateLimitClient,
  type RateLimitDecision
} from "@/platform/rate-limit/postgres-rate-limiter";

export function loginRateLimitIp(headers: Headers): string {
  return (
    headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    headers.get("x-real-ip") ||
    "local"
  );
}

export async function consumeLoginRateLimit(
  email: string,
  ip: string
): Promise<RateLimitDecision> {
  return withTenant(
    prisma as unknown as TenantTransactionRunner,
    bootstrapOrganizationId,
    async (tx) =>
      consumeRateLimit(tx as unknown as RateLimitClient, bootstrapOrganizationId, {
        key: `login:${ip}:${email}`,
        limit: 5,
        windowSeconds: 60
      })
  );
}
