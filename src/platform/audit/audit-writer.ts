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

export const REDACTED_AUDIT_VALUE = "[REDACTED]";

const SENSITIVE_AUDIT_KEYS = new Set([
  "accesstoken",
  "address",
  "apikey",
  "bankaccount",
  "code",
  "codehash",
  "credentialid",
  "displayname",
  "documentnumber",
  "email",
  "iban",
  "idnumber",
  "legalname",
  "nationalid",
  "passkey",
  "passport",
  "password",
  "passwordhash",
  "phone",
  "pin",
  "privatekey",
  "publickey",
  "recoverycode",
  "refreshtoken",
  "secret",
  "secretencrypted",
  "secrethash",
  "session",
  "swift",
  "token",
  "totp"
]);

const REASON_REQUIRED_ACTION_TOKENS = new Set([
  "adjust",
  "adjustment",
  "override",
  "reopen",
  "reopened",
  "reverse",
  "reversed",
  "void",
  "voided"
]);

function normalizeAuditKey(key: string): string {
  return key.replace(/[^a-z0-9]/giu, "").toLowerCase();
}

function actionTokens(action: string): string[] {
  return action
    .replace(/([a-z])([A-Z])/gu, "$1.$2")
    .toLowerCase()
    .split(/[^a-z0-9]+/u)
    .filter(Boolean);
}

export function isReasonRequiredAuditAction(action: string): boolean {
  return actionTokens(action).some((token) => REASON_REQUIRED_ACTION_TOKENS.has(token));
}

function normalizeAuditReason(reason: string | null | undefined): string | null {
  const trimmed = reason?.trim();
  return trimmed ? trimmed : null;
}

export function redactAuditPayload(value: Prisma.JsonValue): Prisma.JsonValue {
  if (Array.isArray(value)) {
    return value.map((item) => redactAuditPayload(item));
  }

  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      (Object.entries(value) as [string, Prisma.JsonValue][]).map(([key, item]) => [
        key,
        SENSITIVE_AUDIT_KEYS.has(normalizeAuditKey(key))
          ? REDACTED_AUDIT_VALUE
          : redactAuditPayload(item)
      ])
    );
  }

  return value;
}

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

  return redactAuditPayload(JSON.parse(serialized) as Prisma.JsonValue) as Prisma.InputJsonValue;
}

function auditEventData(event: AuditEvent): Parameters<AuditClient["auditLog"]["create"]>[0]["data"] {
  const reason = normalizeAuditReason(event.reason);

  if (isReasonRequiredAuditAction(event.action) && reason === null) {
    throw new TypeError("Audit reason is required for reason-required actions");
  }

  return {
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
  };
}

export async function writeAuditEvent(client: AuditClient, event: AuditEvent): Promise<void> {
  await client.auditLog.create({ data: auditEventData(event) });
}

export async function writeAuditEvents(client: { auditLog: { createMany(args: { data: Array<ReturnType<typeof auditEventData>> }): Promise<unknown> } }, events: AuditEvent[]): Promise<void> {
  // Database row triggers still enforce append-only history for every row.
  const data = events.map(auditEventData);
  if (data.length) await client.auditLog.createMany({ data });
}
