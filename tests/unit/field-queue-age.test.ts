import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { fieldQueueAge } from "@/platform/offline/field-queue-age";
import type { FieldQueueEntry } from "@/platform/offline/field-queue-store";

const scope = { organizationId: randomUUID(), userId: randomUUID() }, taskId = randomUUID(), created = Date.parse("2026-10-24T12:00:00Z");
const policy = (minutes: number | null) => ({ configRuleId: randomUUID(), configVersion: 1, queueWarningAfterMinutes: minutes });
function entry(minutes: number | null = 1): FieldQueueEntry {
  const nonce = randomUUID();
  return { ...scope, localId: nonce, deviceId: randomUUID(), syncStatus: "pending", devicePolicy: policy(minutes), operation: {
    client_op_id: nonce, client_created_at: new Date(created).toISOString(), type: "field_task.complete", payload: { taskId, checklistItemIds: [randomUUID()] }
  } };
}

describe("configured local queue age", () => {
  it("warns exactly at the configured boundary and schedules the next change without altering an operation", () => {
    const value = entry(), original = structuredClone(value);
    expect(fieldQueueAge(scope, [value], [], created + 59_999)).toEqual({ count: 0, oldestMinutes: 0, nextCheckAfterMs: 1 });
    expect(fieldQueueAge(scope, [value], [], created + 60_000)).toEqual({ count: 1, oldestMinutes: 1, nextCheckAfterMs: 60_000 });
    expect(fieldQueueAge(scope, [value], [], created + 90_000)).toEqual({ count: 1, oldestMinutes: 1, nextCheckAfterMs: 30_000 });
    expect(value).toEqual(original);
  });
  it("uses the current scoped policy and explicit disable while retaining the queued version as an offline fallback", () => {
    const value = entry(1), now = created + 120_000;
    expect(fieldQueueAge(scope, [value], [], now).count).toBe(1);
    expect(fieldQueueAge(scope, [value], [{ id: taskId, devicePolicy: policy(3) }], now)).toEqual({ count: 0, oldestMinutes: 0, nextCheckAfterMs: 60_000 });
    expect(fieldQueueAge(scope, [value], [{ id: taskId, devicePolicy: policy(null) }], now).count).toBe(0);
    expect(fieldQueueAge(scope, [value], [{ id: taskId, devicePolicy: null }], now).count).toBe(0);
    expect(fieldQueueAge(scope, [value], [{ id: taskId }], now).count).toBe(1);
    expect(value.devicePolicy?.queueWarningAfterMinutes).toBe(1);
  });
  it("counts actionable failures but excludes resolved history and every other organization or account", () => {
    const first = entry(0), second = { ...entry(0), syncStatus: "conflict" as const }, resolved = { ...entry(0), resolvedByClientOpId: randomUUID() };
    const rows = [first, second, resolved, { ...entry(0), organizationId: randomUUID() }, { ...entry(0), userId: randomUUID() }];
    expect(fieldQueueAge(scope, rows, [], created + 600_000)).toEqual({ count: 2, oldestMinutes: 10, nextCheckAfterMs: 60_000 });
  });
  it("never supplies a duration for missing, invalid or disabled configuration", () => {
    const missing = entry(); delete missing.devicePolicy;
    const invalid = { ...entry(), devicePolicy: { ...policy(1), amount: "100.00" } };
    expect(fieldQueueAge(scope, [missing, invalid, entry(null)], [], created + 1_000_000)).toEqual({ count: 0, oldestMinutes: 0, nextCheckAfterMs: null });
  });
  it("handles missing timestamps, future device clocks and long configured durations without negative ages", () => {
    const missing = entry(0); delete missing.operation.client_created_at;
    expect(fieldQueueAge(scope, [missing], [], created + 60_000).count).toBe(0);
    expect(fieldQueueAge(scope, [entry(0)], [], created - 60_000).oldestMinutes).toBe(0);
    expect(fieldQueueAge(scope, [entry(100_000)], [], created).nextCheckAfterMs).toBe(6_000_000_000);
    expect(fieldQueueAge(scope, [entry(0)], [], Number.NaN)).toEqual({ count: 0, oldestMinutes: 0, nextCheckAfterMs: null });
  });
});
