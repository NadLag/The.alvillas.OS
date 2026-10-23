import { describe, expect, it } from "vitest";
import { parseSyncPushInput } from "@/modules/reservations/application/sync-service";

describe("sync push protocol", () => {
  it("accepts field task completion ops with client idempotency", () => {
    const parsed = parseSyncPushInput({
      device_id: "field-device-0001",
      organization_id: "018f0a0b-0000-7000-9000-000000000001",
      actor_user_id: "018f0a0b-0000-7000-9000-000000000002",
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
      organization_id: "018f0a0b-0000-7000-9000-000000000001",
      actor_user_id: "018f0a0b-0000-7000-9000-000000000002",
      op_schema_version: 1,
      ops: []
    });

    expect(parsed.success).toBe(false);
  });

  it.each(["organization_id", "actor_user_id"])("requires %s before an offline operation can reach the current session", key => {
    const input: Record<string, unknown> = { device_id: "legacy-device-0001", op_schema_version: 1,
      organization_id: "018f0a0b-0000-7000-9000-000000000001", actor_user_id: "018f0a0b-0000-7000-9000-000000000002",
      ops: [{ client_op_id: "018f0a0b-0000-7000-9000-000000000901", type: "field_task.complete",
        payload: { taskId: "018f0a0b-0000-7000-9000-000000000902", checklistItemIds: ["018f0a0b-0000-7000-9000-000000000903"] } }] };
    delete input[key];
    expect(parseSyncPushInput(input).success).toBe(false);
  });

  it.each(["ops", "checklistItemIds"] as const)("rejects oversized %s before inspecting its elements", collection => {
    const id = "018f0a0b-0000-7000-9000-000000000903";
    const op = { client_op_id: "018f0a0b-0000-7000-9000-000000000901", type: "field_task.complete",
      payload: { taskId: "018f0a0b-0000-7000-9000-000000000902", checklistItemIds: [id] } };
    const element = collection === "ops" ? op : id;
    const oversized = Array.from({ length: 5000 }, () => element);
    let inspected = 0;
    Object.defineProperty(oversized, "0", { get: () => { inspected += 1; return element; } });
    const parsed = parseSyncPushInput({ device_id: "field-device-0001", op_schema_version: 1,
      organization_id: "018f0a0b-0000-7000-9000-000000000001", actor_user_id: "018f0a0b-0000-7000-9000-000000000002",
      ops: collection === "ops" ? oversized : [{ ...op, payload: { ...op.payload, checklistItemIds: oversized } }] });
    expect(parsed.success).toBe(false);
    if (parsed.success) throw new Error("Oversized field sync collection was accepted");
    expect(parsed.error.issues.map(issue => ({ code: issue.code, path: issue.path }))).toEqual([
      { code: "too_big", path: collection === "ops" ? ["ops"] : ["ops", 0, "payload", "checklistItemIds"] }
    ]);
    expect(inspected).toBe(0);
  });
});
