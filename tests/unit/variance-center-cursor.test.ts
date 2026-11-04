import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { encodeVarianceCenterCursor, decodeVarianceCenterCursor } from "@/modules/finance/application/variance-center-cursor";
import { VarianceCenterCursorError, varianceCenterFilterSchema, varianceCenterPositionSchema } from "@/modules/finance/domain/variance-center";
import type { FinanceActorContext } from "@/modules/finance/application/finance-access";

const org = randomUUID(), actor = randomUUID(), ctx: FinanceActorContext = { organizationId: org, actorId: actor,
  authContext: { organizationId: org, userAccountId: actor, permissions: new Set(["task:view"]), scopes: [{ organizationId: org, scopeType: "organization" }] } };
const now = new Date("2031-05-01T12:00:00.000Z"), filter = varianceCenterFilterSchema.parse({ provider: "INVENTORY" });
const after = { id: randomUUID(), at: "2031-04-30T11:22:33.123456Z" }, env: NodeJS.ProcessEnv = { NODE_ENV: "test", ENCRYPTION_KEYS: "local:" + Buffer.alloc(32, 0x37).toString("base64") };
const token = () => encodeVarianceCenterCursor(ctx, ctx.authContext, filter, after, now, env);
describe("private native variance continuation", () => {
  it("retains exact source microseconds in a randomized authenticated envelope", () => {
    const first = token(), second = token(); expect(first).not.toBe(second); expect(first).not.toContain(after.id);
    expect(decodeVarianceCenterCursor(first, ctx, ctx.authContext, filter, now, env)).toEqual(after);
    expect(varianceCenterPositionSchema.safeParse({ ...after, at: "2031-04-30T11:22:33.123Z" }).success).toBe(false);
  });
  it("binds organization, actor, provider and every active filter", () => {
    const cursor = token();
    for (const changed of [{ ...ctx, actorId: randomUUID() }, { ...ctx, organizationId: randomUUID() }])
      expect(() => decodeVarianceCenterCursor(cursor, changed, ctx.authContext, filter, now, env)).toThrow(VarianceCenterCursorError);
    for (const changed of [{ ...filter, provider: "BANK" as const }, { ...filter, status: "ALL" as const }, { ...filter, assignment: "ME" as const }])
      expect(() => decodeVarianceCenterCursor(cursor, ctx, ctx.authContext, changed, now, env)).toThrow(VarianceCenterCursorError);
  });
  it("rejects a changed held restriction or independently ended stored authority", () => {
    const cursor = token(), changed = { ...ctx.authContext, permissions: new Set<string>() };
    expect(() => decodeVarianceCenterCursor(cursor, { ...ctx, authContext: changed }, ctx.authContext, filter, now, env)).toThrow(VarianceCenterCursorError);
    expect(() => decodeVarianceCenterCursor(cursor, ctx, changed, filter, now, env)).toThrow(VarianceCenterCursorError);
  });
  it("rejects tampering, another key, future issue time and expired continuation", () => {
    const cursor = token();
    for (const malformed of ["invalid", cursor.slice(0, -3) + "AAA", "a".repeat(8193), " "])
      expect(() => decodeVarianceCenterCursor(malformed, ctx, ctx.authContext, filter, now, env)).toThrow(VarianceCenterCursorError);
    expect(() => decodeVarianceCenterCursor(cursor, ctx, ctx.authContext, filter, now, { ...env, ENCRYPTION_KEYS: "other:" + Buffer.alloc(32, 0x42).toString("base64") })).toThrow(VarianceCenterCursorError);
    expect(() => decodeVarianceCenterCursor(cursor, ctx, ctx.authContext, filter, new Date(now.getTime() - 1), env)).toThrow(VarianceCenterCursorError);
    expect(() => decodeVarianceCenterCursor(cursor, ctx, ctx.authContext, filter, new Date(now.getTime() + 300000), env)).toThrow(VarianceCenterCursorError);
  });
  it("expires at an independently retained stored grant transition", () => {
    const current = { ...ctx.authContext, assignments: [{ permissions: new Set(["task:view"]), scope: { organizationId: org, scopeType: "organization" as const },
      validFrom: new Date(now.getTime() - 1000), validTo: new Date(now.getTime() + 1000) }] };
    const cursor = encodeVarianceCenterCursor(ctx, current, filter, after, now, env);
    expect(() => decodeVarianceCenterCursor(cursor, ctx, current, filter, new Date(now.getTime() + 999), env)).not.toThrow();
    expect(() => decodeVarianceCenterCursor(cursor, ctx, current, filter, new Date(now.getTime() + 1000), env)).toThrow(VarianceCenterCursorError);
  });
});
