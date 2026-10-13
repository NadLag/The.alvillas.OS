import { describe, expect, it, vi } from "vitest";
import { writeAuditEvent } from "@/platform/audit/audit-writer";
import type { AuditEvent } from "@/platform/audit/audit-event";

const baseEvent: AuditEvent = {
  organizationId: "018f0a0b-0000-7000-9000-000000000001",
  actorId: "018f0a0b-0000-7000-9000-000000000002",
  action: "reservation.update",
  resourceType: "reservation",
  resourceId: "018f0a0b-0000-7000-9000-000000000003",
  ipAddress: "127.0.0.1",
  deviceId: "device-1",
  propertyScopeId: "018f0a0b-0000-7000-9000-000000000004",
  before: { status: "draft" },
  after: { status: "confirmed" },
  reason: "owner approved",
  requestId: "req-1",
  occurredAt: new Date("2026-10-11T00:00:00.000Z")
};

describe("writeAuditEvent", () => {
  it("writes a complete service-layer audit row", async () => {
    const create = vi.fn().mockResolvedValue({});

    await writeAuditEvent({ auditLog: { create } }, baseEvent);

    expect(create).toHaveBeenCalledWith({
      data: {
        organizationId: baseEvent.organizationId,
        actorId: baseEvent.actorId,
        action: "reservation.update",
        resourceType: "reservation",
        resourceId: baseEvent.resourceId,
        ipAddress: "127.0.0.1",
        deviceId: "device-1",
        propertyScopeId: baseEvent.propertyScopeId,
        before: { status: "draft" },
        after: { status: "confirmed" },
        reason: "owner approved",
        requestId: "req-1",
        occurredAt: baseEvent.occurredAt
      }
    });
  });

  it("rejects non-JSON audit payloads before writing", async () => {
    const create = vi.fn().mockResolvedValue({});

    await expect(
      writeAuditEvent(
        { auditLog: { create } },
        {
          ...baseEvent,
          before: { invalid: 1n }
        }
      )
    ).rejects.toThrow("Audit payload must be JSON serializable");

    expect(create).not.toHaveBeenCalled();
  });

  it("redacts secrets and personal data from audit payloads", async () => {
    const create = vi.fn().mockResolvedValue({});

    await writeAuditEvent(
      { auditLog: { create } },
      {
        ...baseEvent,
        before: {
          email: "owner@example.com",
          status: "draft",
          nested: {
            passwordHash: "hash",
            safe: "ok"
          },
          guests: [
            {
              phone: "+212600000000",
              nights: 2
            }
          ],
          occurredAt: new Date("2026-10-10T12:00:00.000Z")
        },
        after: {
          codeHash: "abc123",
          revenueCents: 45000
        }
      }
    );

    expect(create).toHaveBeenCalledWith({
      data: {
        organizationId: baseEvent.organizationId,
        actorId: baseEvent.actorId,
        action: "reservation.update",
        resourceType: "reservation",
        resourceId: baseEvent.resourceId,
        ipAddress: "127.0.0.1",
        deviceId: "device-1",
        propertyScopeId: baseEvent.propertyScopeId,
        before: {
          email: "[REDACTED]",
          status: "draft",
          nested: {
            passwordHash: "[REDACTED]",
            safe: "ok"
          },
          guests: [
            {
              phone: "[REDACTED]",
              nights: 2
            }
          ],
          occurredAt: "2026-10-10T12:00:00.000Z"
        },
        after: {
          codeHash: "[REDACTED]",
          revenueCents: 45000
        },
        reason: "owner approved",
        requestId: "req-1",
        occurredAt: baseEvent.occurredAt
      }
    });
  });

  it("requires a reason before writing reason-required audit actions", async () => {
    const create = vi.fn().mockResolvedValue({});

    await expect(
      writeAuditEvent(
        { auditLog: { create } },
        {
          ...baseEvent,
          action: "reservation.revenue.reversed",
          reason: "   "
        }
      )
    ).rejects.toThrow("Audit reason is required for reason-required actions");

    expect(create).not.toHaveBeenCalled();
  });

  it("trims reason text for reason-required audit actions", async () => {
    const create = vi.fn().mockResolvedValue({});

    await writeAuditEvent(
      { auditLog: { create } },
      {
        ...baseEvent,
        action: "wallet.adjustment.create",
        reason: "  Owner correction  "
      }
    );

    expect(create).toHaveBeenCalledWith({
      data: {
        organizationId: baseEvent.organizationId,
        actorId: baseEvent.actorId,
        action: "wallet.adjustment.create",
        resourceType: "reservation",
        resourceId: baseEvent.resourceId,
        ipAddress: "127.0.0.1",
        deviceId: "device-1",
        propertyScopeId: baseEvent.propertyScopeId,
        before: { status: "draft" },
        after: { status: "confirmed" },
        reason: "Owner correction",
        requestId: "req-1",
        occurredAt: baseEvent.occurredAt
      }
    });
  });
});
