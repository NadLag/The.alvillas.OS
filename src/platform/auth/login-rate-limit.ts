import { AsyncLocalStorage } from "node:async_hooks";
import { prisma } from "@/platform/db/client";
import { withTenant, type TenantTransactionRunner } from "@/platform/db/tenant";
import { bootstrapOrganizationId } from "@/platform/identity/bootstrap";
import {
  consumeRateLimit,
  type RateLimitClient,
  type RateLimitDecision
} from "@/platform/rate-limit/postgres-rate-limiter";

const checkedLogin = new AsyncLocalStorage<{ key: string; ip: string }>();

export function withCheckedLoginRateLimit<T>(key: string, ip: string, callback: () => T): T {
  return checkedLogin.run({ key, ip }, callback);
}

export function loginRateLimitWasChecked(key: string, ip: string): boolean {
  const checked = checkedLogin.getStore();
  return checked?.key === key && checked.ip === ip;
}

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
