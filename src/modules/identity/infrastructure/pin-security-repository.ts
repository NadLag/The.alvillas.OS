import { Prisma } from "@prisma/client";
import { ConfigRuleRepository, type ConfigRuleRecord } from "@/platform/config/config-rule-repository";
import { hashRateLimitKey } from "@/platform/rate-limit/postgres-rate-limiter";
import type { TenantTransaction } from "@/platform/db/tenant";
import {
  initialPinLockoutPolicy, pinLockoutConfigKey, pinLockoutPolicySchema, type PinFailureState
} from "@/modules/identity/domain/pin-lockout";

const lockoutEpoch = new Date(0);

export class PinSecurityRepository {
  constructor(private readonly tx: TenantTransaction, private readonly organizationId: string) {}

  private key(phone: string) { return hashRateLimitKey(`identity.pin:${phone.trim().toLowerCase()}`); }

  async lock(phone: string): Promise<void> {
    await this.tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${this.organizationId}:${this.key(phone)}`}, 0))`);
  }

  async policy(now: Date, onInitialized?: (rule: ConfigRuleRecord) => Promise<void>) {
    const repository = new ConfigRuleRepository(this.tx, this.organizationId);
    const resolved = await repository.resolve({
      key: pinLockoutConfigKey, scopes: [{ scopeType: "organization", scopeId: null }], asOf: now
    });
    if (resolved) return pinLockoutPolicySchema.parse(resolved.parsedValue);
    // Serialize first-time policy provisioning across different phone numbers.
    await this.tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${this.organizationId}:${pinLockoutConfigKey}`}, 0))`);
    const existing = await repository.resolve({
      key: pinLockoutConfigKey, scopes: [{ scopeType: "organization", scopeId: null }], asOf: now
    });
    if (existing) return pinLockoutPolicySchema.parse(existing.parsedValue);
    if ((await repository.list({ key: pinLockoutConfigKey, scopeType: "organization", scopeId: null, take: 1 })).length) {
      throw new Error("An active PIN security policy is required");
    }
    const created = await repository.createVersion({
      key: pinLockoutConfigKey, scopeType: "organization", value: initialPinLockoutPolicy,
      effectiveFrom: now, reason: "Initialize identity PIN security policy"
    });
    await onInitialized?.(created);
    return pinLockoutPolicySchema.parse(created.value);
  }

  state(phone: string): Promise<PinFailureState | null> {
    return this.tx.rateLimitBucket.findUnique({
      where: { organizationId_keyHash_windowStart_windowSeconds: {
        organizationId: this.organizationId, keyHash: this.key(phone), windowStart: lockoutEpoch, windowSeconds: 1
      } }, select: { count: true, updatedAt: true }
    });
  }

  async save(phone: string, count: number, now: Date): Promise<void> {
    await this.tx.rateLimitBucket.upsert({
      where: { organizationId_keyHash_windowStart_windowSeconds: {
        organizationId: this.organizationId, keyHash: this.key(phone), windowStart: lockoutEpoch, windowSeconds: 1
      } },
      create: { organizationId: this.organizationId, keyHash: this.key(phone), windowStart: lockoutEpoch, windowSeconds: 1, count, updatedAt: now },
      update: { count, updatedAt: now }
    });
  }
}
