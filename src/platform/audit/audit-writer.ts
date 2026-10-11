import { Prisma } from "@prisma/client";
import type { AuditEvent } from "@/platform/audit/audit-event";

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

function toAuditJson(
  value: unknown
): Prisma.InputJsonValue | typeof Prisma.JsonNull | undefined {
  if (value === undefined) {
    return undefined;
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

  return JSON.parse(serialized) as Prisma.InputJsonValue;
}

export async function writeAuditEvent(client: AuditClient, event: AuditEvent): Promise<void> {
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
      reason: event.reason ?? null,
      requestId: event.requestId,
      occurredAt: event.occurredAt
    }
  });
}
