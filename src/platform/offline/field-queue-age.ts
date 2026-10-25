import type { FieldWorkSnapshot } from "@/modules/reservations/domain/field-pull";
import { fieldDevicePolicySnapshotSchema } from "@/platform/config/field-device-policy";
import type { FieldQueueEntry, FieldQueueScope } from "./field-queue-store";

export type FieldQueueAge = { count: number; oldestMinutes: number; nextCheckAfterMs: number | null };

export function fieldQueueAge(scope: FieldQueueScope, entries: readonly FieldQueueEntry[], tasks: readonly Pick<FieldWorkSnapshot, "id" | "devicePolicy">[], now: number): FieldQueueAge {
  let count = 0, oldestMinutes = 0, next = Number.POSITIVE_INFINITY;
  const cached = new Map(tasks.map(task => [task.id, task]));
  if (!Number.isFinite(now)) return { count, oldestMinutes, nextCheckAfterMs: null };
  for (const entry of entries) {
    if (entry.organizationId !== scope.organizationId || entry.userId !== scope.userId || entry.resolvedByClientOpId) continue;
    const task = cached.get(entry.operation.payload.taskId);
    const value = task && Object.hasOwn(task, "devicePolicy") ? task.devicePolicy : entry.devicePolicy;
    const parsed = fieldDevicePolicySnapshotSchema.safeParse(value);
    if (!parsed.success || parsed.data.queueWarningAfterMinutes === null) continue;
    const created = Date.parse(entry.operation.client_created_at ?? "");
    if (!Number.isFinite(created)) continue;
    const elapsed = Math.max(0, now - created), threshold = parsed.data.queueWarningAfterMinutes * 60_000;
    if (elapsed >= threshold) {
      count += 1; oldestMinutes = Math.max(oldestMinutes, Math.floor(elapsed / 60_000));
      next = Math.min(next, 60_000 - elapsed % 60_000);
    } else next = Math.min(next, threshold - elapsed);
  }
  return { count, oldestMinutes, nextCheckAfterMs: Number.isFinite(next) ? Math.max(1, next) : null };
}
