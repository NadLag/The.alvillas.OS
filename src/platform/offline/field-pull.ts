import { fieldPullResultSchema, type FieldWorkSnapshot } from "@/modules/reservations/domain/field-pull";
import { fieldIdentity, type FieldQueueScope, type FieldQueueStore } from "./field-queue-store";

const active = new WeakMap<FieldQueueStore, Map<string, Promise<void>>>();
export function refreshFieldCache(queue: FieldQueueStore, scope: FieldQueueScope, send: typeof fetch = fetch): Promise<void> {
  let pending = active.get(queue);
  if (!pending) { pending = new Map(); active.set(queue, pending); }
  const key = fieldIdentity(scope), existing = pending.get(key);
  if (existing) return existing;
  const result = refresh(queue, scope, send).finally(() => pending.delete(key));
  pending.set(key, result); return result;
}

async function refresh(queue: FieldQueueStore, scope: FieldQueueScope, send: typeof fetch): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const original = await queue.readCache(scope);
    if (!original.state) throw new Error("FIELD_SESSION_CHANGED");
    const revision = { incarnation: original.state.incarnation, generation: original.state.generation };
    const known = original.tasks.map(({ id, revision }) => `${id}.${revision}`), staged = new Map<string, FieldWorkSnapshot>();
    const removed = new Set<string>(), visited = new Set<string>();
    let cursor = original.state?.cursor, next: string | null = null, offset = 0, snapshotAt = "", reset = false;
    do {
      const params = new URLSearchParams({ organization_id: scope.organizationId, actor_user_id: scope.userId, mode: "assigned" });
      if (cursor) params.set("cursor", cursor);
      if (next === null && offset > 0) params.set("only_known", "1");
      if (known.length > offset) params.set("known_tasks", known.slice(offset, offset + 50).join(","));
      const response = await send(`/api/sync/pull?${params}`, { credentials: "same-origin", cache: "no-store" });
      if (response.status === 401 || response.status === 403) { await queue.wipe(scope); throw new Error("FIELD_SESSION_CHANGED"); }
      if (response.status === 409 || response.status === 400) { await queue.invalidateCache(scope); reset = true; break; }
      if (!response.ok) throw new Error("FIELD_PULL_UNAVAILABLE");
      const result = fieldPullResultSchema.parse(await response.json());
      if (result.organization_id !== scope.organizationId || result.actor_user_id !== scope.userId) throw new Error("FIELD_PULL_OWNER_MISMATCH");
      for (const task of [...result.tasks, ...result.known_changes]) { staged.set(task.id, task); removed.delete(task.id); }
      for (const id of result.tombstones) { removed.add(id); staged.delete(id); }
      cursor = result.cursor; next = result.next_cursor; offset += 50; snapshotAt = result.snapshot_at;
      if (next && visited.has(next)) throw new Error("FIELD_PULL_CURSOR_LOOP");
      if (next) visited.add(next);
    } while (next || offset < known.length);
    if (reset) continue;
    if (cursor && await queue.publishCache(scope, revision, [...staged.values()], [...removed], cursor, snapshotAt)) return;
  }
  throw new Error("FIELD_PULL_RETRY_REQUIRED");
}
