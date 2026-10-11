import { describe, expect, it } from "vitest";
import { parseSyncPushInput } from "@/modules/reservations/application/sync-service";

describe("sync push protocol", () => {
  it("accepts field task completion ops with client idempotency", () => {
    const parsed = parseSyncPushInput({
      device_id: "field-device-0001",
      op_schema_version: 1,
      ops: [
        {
          client_op_id: "018f0a0b-0000-7000-9000-000000000901",
          type: "field_task.complete",
          payload: {
            taskId: "018f0a0b-0000-7000-9000-000000000902",
            checklistItemIds: ["018f0a0b-0000-7000-9000-000000000903"],
            note: "Queued offline"
          },
          client_created_at: "2026-10-11T12:00:00.000Z"
        }
      ]
    });

    expect(parsed.success).toBe(true);
  });

  it("rejects empty operation batches", () => {
    const parsed = parseSyncPushInput({
      device_id: "field-device-0001",
      op_schema_version: 1,
      ops: []
    });

    expect(parsed.success).toBe(false);
  });
});
