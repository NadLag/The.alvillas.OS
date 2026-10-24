import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { ReservationActorContext } from "@/modules/reservations/application/reservation-access";
import { decodeFieldPullCursor, encodeFieldPullCursor, fieldScopeStamp, newFieldPullCursor } from "@/modules/reservations/application/field-pull-cursor";
import { fieldPullInputSchema } from "@/modules/reservations/domain/field-pull";
import { calendarDateAt } from "@/i18n/format";

const now = new Date("2026-10-23T23:30:00Z");
const env = { NODE_ENV: "test", ENCRYPTION_KEYS: "v1:" + Buffer.alloc(32, 17).toString("base64") } satisfies NodeJS.ProcessEnv;
function fixture() {
  const organizationId = randomUUID(), actorId = randomUUID(), personId = randomUUID();
  const ctx: ReservationActorContext = { organizationId, actorId, personId, authContext: {
    organizationId, userAccountId: actorId, personId, permissions: new Set(["task:view", "task:edit"]),
    scopes: [{ organizationId, scopeType: "property", scopeId: randomUUID() }]
  } };
  const input = fieldPullInputSchema.parse({ organization_id: organizationId, actor_user_id: actorId });
  return { ctx, input, frame: newFieldPullCursor(ctx, input, now) };
}
describe("field pull cursor security", () => {
  it("keeps legacy tokens unchanged and binds opted-in policy projections to their cursor", () => {
    const { ctx, input, frame } = fixture();
    expect(frame).not.toHaveProperty("devicePolicy");
    const legacy = encodeFieldPullCursor(frame, ctx, env), optedIn = { ...input, include_device_policy: true };
    expect(decodeFieldPullCursor(legacy, ctx, input, now, env)).toEqual(frame);
    expect(() => decodeFieldPullCursor(legacy, ctx, optedIn, now, env)).toThrow("invalid_cursor");
    const extended = newFieldPullCursor(ctx, optedIn, now), token = encodeFieldPullCursor(extended, ctx, env);
    expect(extended.devicePolicy).toBe(true);
    expect(decodeFieldPullCursor(token, ctx, optedIn, now, env)).toEqual(extended);
    expect(() => decodeFieldPullCursor(token, ctx, input, now, env)).toThrow("invalid_cursor");
    expect(fieldPullInputSchema.safeParse({ ...input, include_device_policy: "1" }).success).toBe(false);
  });
  it("encrypts pagination and binds it to the organization, actor and view", () => {
    const { ctx, input, frame } = fixture();
    const page = { ...frame, kind: "page" as const, after: { date: "2026-10-23", id: randomUUID() } };
    const token = encodeFieldPullCursor(page, ctx, env);
    expect(Buffer.from(token, "base64url").toString("utf8")).not.toContain(page.after.id);
    expect(decodeFieldPullCursor(token, ctx, input, now, env)).toEqual(page);
    expect(() => decodeFieldPullCursor(token, { ...ctx, actorId: randomUUID() }, input, now, env)).toThrow("invalid_cursor");
    expect(() => decodeFieldPullCursor(token, { ...ctx, organizationId: randomUUID() }, input, now, env)).toThrow("invalid_cursor");
    expect(() => decodeFieldPullCursor(token, ctx, { ...input, mode: "assigned" }, now, env)).toThrow("invalid_cursor");
    expect(() => decodeFieldPullCursor(token, ctx, { ...input, property_id: randomUUID() }, now, env)).toThrow("invalid_cursor");
    const bytes = Buffer.from(token, "base64url"); bytes[bytes.length - 1] ^= 1;
    expect(() => decodeFieldPullCursor(bytes.toString("base64url"), ctx, input, now, env)).toThrow("invalid_cursor");
  });
  it("restarts pagination after role changes or expiry while allowing a fresh cycle from an old checkpoint", () => {
    const { ctx, input, frame } = fixture(), changed = { ...ctx, authContext: { ...ctx.authContext, permissions: new Set(["task:view"]) } };
    const page = encodeFieldPullCursor({ ...frame, kind: "page" }, ctx, env);
    expect(() => decodeFieldPullCursor(page, changed, input, now, env)).toThrow("reset_required");
    const later = new Date(now.getTime() + 300_000);
    expect(() => decodeFieldPullCursor(page, ctx, input, later, env)).toThrow("reset_required");
    const checkpoint = encodeFieldPullCursor(frame, ctx, env);
    expect(decodeFieldPullCursor(checkpoint, ctx, input, later, env).kind).toBe("checkpoint");
    expect(() => decodeFieldPullCursor(checkpoint, ctx, { ...input, only_known: true }, later, env)).toThrow("reset_required");
    expect(() => decodeFieldPullCursor(page, ctx, { ...input, only_known: true }, now, env)).toThrow("invalid_cursor");
  });
  it("expires a page at the next authorization boundary and survives encryption key rotation", () => {
    const { ctx, input } = fixture(), boundary = new Date(now.getTime() + 60_000);
    ctx.authContext.assignments = [{ permissions: ctx.authContext.permissions, scope: ctx.authContext.scopes[0], validTo: boundary }];
    const frame = newFieldPullCursor(ctx, input, now);
    expect(frame.expiresAt).toBe(boundary.toISOString());
    const token = encodeFieldPullCursor(frame, ctx, env);
    expect(decodeFieldPullCursor(token, ctx, input, now, { ...env, ENCRYPTION_KEYS: "v2:" + Buffer.alloc(32, 18).toString("base64") + "," + env.ENCRYPTION_KEYS })).toEqual(frame);
  });
  it("normalizes grant ordering but detects changes to role scopes, conditions and person identity", () => {
    const { ctx } = fixture(), scope = ctx.authContext.scopes[0];
    ctx.authContext.assignments = [{ scope, permissions: new Set(["task:edit", "task:view"]), conditions: { statuses: ["ASSIGNED", "IN_PROGRESS"] } }];
    const stamp = fieldScopeStamp(ctx.authContext);
    const reordered = { ...ctx.authContext, permissions: new Set(["task:edit", "task:view"]), assignments: [{ scope, permissions: new Set(["task:view", "task:edit"]), conditions: { statuses: ["IN_PROGRESS", "ASSIGNED"] } }] };
    expect(fieldScopeStamp(reordered)).toBe(stamp);
    expect(fieldScopeStamp({ ...reordered, personId: randomUUID() })).not.toBe(stamp);
    expect(fieldScopeStamp({ ...reordered, assignments: [{ ...reordered.assignments[0], conditions: { assignedToMe: true } }] })).not.toBe(stamp);
  });
});
describe("field business dates", () => {
  it.each([
    // tzdb 2026c records Morocco's September 2026 change; never substitute a fixed offset.
    ["2026-05-23T23:30:00Z", "Africa/Casablanca", "2026-05-24"],
    ["2026-10-23T23:30:00Z", "Africa/Casablanca", "2026-10-23"],
    ["2026-10-23T23:30:00Z", "America/Denver", "2026-10-23"],
    ["2026-10-23T10:30:00Z", "Pacific/Kiritimati", "2026-10-24"],
    ["2026-11-01T07:30:00Z", "America/Denver", "2026-11-01"],
    ["2026-11-01T08:30:00Z", "America/Denver", "2026-11-01"]
  ])("uses the configured IANA calendar for %s in %s", (value, zone, date) => {
    expect(calendarDateAt(new Date(value), zone)).toBe(date);
  });
});
