import { z } from "zod";
import { fieldIdentity, type FieldQueueScope, type FieldQueueStore } from "./field-queue-store";

const session = z.object({ user: z.object({ id: z.uuid(), organizationId: z.uuid(), securitySetupRequired: z.literal(false), sessionRevoked: z.literal(false).optional() }) });
function parseIdentity(value?: string): FieldQueueScope | null {
  const [organizationId, userId] = value?.split(":") ?? [];
  return z.uuid().safeParse(organizationId).success && z.uuid().safeParse(userId).success ? { organizationId, userId } : null;
}

/** Recheck the session before revealing saved work; stale requests cannot erase a new account. */
export async function resolveFieldScope(queue: FieldQueueStore, online: boolean, expected?: FieldQueueScope, send: typeof fetch = fetch): Promise<FieldQueueScope | null> {
  const before = (await queue.metadata.get("identity"))?.value, previous = parseIdentity(before);
  let candidate = previous;
  if (online) {
    let response: Response | undefined;
    const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 5000);
    try { response = await send("/api/auth/session", { credentials: "same-origin", cache: "no-store", signal: controller.signal }); }
    catch { /* A connection failure keeps the previously verified local owner. */ }
    finally { clearTimeout(timeout); }
    let payload: unknown;
    if (response?.ok) {
      try { payload = await response.json(); } catch { response = undefined; }
    }
    if (response?.ok || response?.status === 401 || response?.status === 403) {
      const parsed = response.ok ? session.safeParse(payload) : null;
      if (!parsed?.success) { if (previous) await queue.wipe(previous); return null; }
      candidate = { organizationId: parsed.data.user.organizationId, userId: parsed.data.user.id };
    } else candidate ??= expected ?? null;
  }
  if (!candidate || (expected && fieldIdentity(candidate) !== fieldIdentity(expected))) return null;
  if (!await queue.activateIfCurrent(candidate, before ?? null)) throw new Error("FIELD_SESSION_CHANGED");
  return candidate;
}
