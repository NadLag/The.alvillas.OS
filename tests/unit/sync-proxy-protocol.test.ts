import { describe, expect, it } from "vitest";
import { parseSyncPushInput } from "@/modules/reservations/application/sync-service";

const id = "018f0a0b-0000-7000-9000-000000000001";
const payload = { taskId: id, expectedVersion: 4, performedByPersonId: id, checklistItemIds: [id], reason: "Reviewed colleague work" };
const batch = (value: unknown) => ({ organization_id: id, actor_user_id: id, device_id: "supervisor-device-001", op_schema_version: 1,
  ops: [{ client_op_id: id, type: "field_task.proxy_validate", payload: value, client_created_at: "2026-10-24T00:00:00-06:00" }] });

describe("queued supervisor protocol", () => {
  it("retains the reviewed task version, performer, reason and original operation identity", () => {
    const parsed = parseSyncPushInput(batch(payload));
    expect(parsed.success).toBe(true);
    if (!parsed.success) throw new Error("Reviewed supervisor operation was rejected");
    expect(parsed.data.ops[0]).toMatchObject({ client_op_id: id, type: "field_task.proxy_validate", payload });
  });
  it.each(["expectedVersion", "performedByPersonId", "reason"] as const)("requires the original reviewed %s", key => {
    const missing: Record<string, unknown> = { ...payload }; delete missing[key];
    expect(parseSyncPushInput(batch(missing)).success).toBe(false);
  });
  it("does not substitute a legacy base version for the reviewed critical version", () => {
    const missing: Record<string, unknown> = { ...payload }; delete missing.expectedVersion;
    const input = batch(missing);
    expect(parseSyncPushInput({ ...input, ops: [{ ...input.ops[0], base_version: "4" }] }).success).toBe(false);
  });
  it("rejects extra attribution and financial fields before business execution", () => {
    expect(parseSyncPushInput(batch({ ...payload, completedByUserAccountId: id })).success).toBe(false);
    expect(parseSyncPushInput(batch({ ...payload, amount: "500.00" })).success).toBe(false);
  });
  it("rejects a blank review reason and a missing checklist", () => {
    expect(parseSyncPushInput(batch({ ...payload, reason: "   " })).success).toBe(false);
    expect(parseSyncPushInput(batch({ ...payload, checklistItemIds: [] })).success).toBe(false);
  });
});
