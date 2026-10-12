import { Prisma } from "@prisma/client";
import {
  auditActionRequiresReason,
  type AuditEvent
} from "@/platform/audit/audit-event";

type AuditClient = {
  auditLog: {
    create(args: {
      data: {
        organizationId: string;
        actorId: string | null;
        action: string;
        resourceType: string;
        resourceId: string | null;
        ipAddress: string | null;
        deviceId: string | null;
        propertyScopeId: string | null;
        before?: Prisma.InputJsonValue | typeof Prisma.JsonNull;
        after?: Prisma.InputJsonValue | typeof Prisma.JsonNull;
        reason: string | null;
        requestId: string;
        occurredAt: Date;
      };
    }): Promise<unknown>;
  };
};

const redactedValue = "[REDACTED]";

const sensitiveKeyPatterns = [
  /password/iu,
  /pin/iu,
  /secret/iu,
  /token/iu,
  /credential/iu,
  /code_hash/iu,
  /codehash/iu,
  /recoverycode/iu,
  /mfacode/iu,
  /totp/iu,
  /passkey/iu,
  /sessionid/iu,
  /sessiontoken/iu,
  /authorization/iu,
  /cookie/iu
];

function isSensitiveKey(key: string): boolean {
  const normalized = key.replaceAll(/[-_\s]/gu, "").toLowerCase();

  return key.toLowerCase() === "code" || sensitiveKeyPatterns.some((pattern) => pattern.test(normalized));
}

export function redactAuditPayload(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => redactAuditPayload(item));
  }

  if (!value || typeof value !== "object") {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, child]) => [
      key,
      isSensitiveKey(key) ? redactedValue : redactAuditPayload(child)
    ])
  );
}

function toAuditJson(value: unknown): Prisma.InputJsonValue | typeof Prisma.JsonNull {
  if (value === undefined) {
    return Prisma.JsonNull;
  }

  if (value === null) {
    return Prisma.JsonNull;
  }

  let serialized: string | undefined;

  try {
    serialized = JSON.stringify(value);
  } catch (error) {
    throw new TypeError("Audit payload must be JSON serializable", { cause: error });
  }

  if (serialized === undefined) {
    throw new TypeError("Audit payload must be JSON serializable");
  }

  return redactAuditPayload(JSON.parse(serialized)) as Prisma.InputJsonValue;
}

export async function writeAuditEvent(client: AuditClient, event: AuditEvent): Promise<void> {
  const reason = event.reason?.trim() ?? null;

  if (auditActionRequiresReason(event.action) && !reason) {
    throw new TypeError(`Audit event ${event.action} requires a reason`);
  }

  await client.auditLog.create({
    data: {
      organizationId: event.organizationId,
      actorId: event.actorId,
      action: event.action,
      resourceType: event.resourceType,
      resourceId: event.resourceId,
      ipAddress: event.ipAddress ?? null,
      deviceId: event.deviceId ?? null,
      propertyScopeId: event.propertyScopeId ?? null,
      before: toAuditJson(event.before),
      after: toAuditJson(event.after),
      reason,
      requestId: event.requestId,
      occurredAt: event.occurredAt
    }
  });
}
