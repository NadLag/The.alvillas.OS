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
});
