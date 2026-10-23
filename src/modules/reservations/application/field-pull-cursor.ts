import { createHash } from "node:crypto";
import { z } from "zod";
import { encryptBytes, decryptBytes } from "@/platform/auth/secret-encryption";
import { assignmentCandidates, type AuthContext, type Scope } from "@/platform/authz/authorize";
import type { ReservationActorContext } from "./reservation-access";
import type { FieldPullInput } from "../domain/field-pull";
import { stayDateSchema } from "../domain/reservation";

export class FieldPullError extends Error {
  constructor(readonly code: "forbidden" | "reset_required" | "invalid_cursor") { super(code); }
}
const cursorSchema = z.object({
  kind: z.enum(["page", "checkpoint"]), mode: z.enum(["today", "assigned"]), propertyId: z.uuid().nullable(),
  scope: z.string().regex(/^[a-zA-Z0-9_-]{43}$/u), asOf: z.iso.datetime(), expiresAt: z.iso.datetime(),
  after: z.object({ date: stayDateSchema, id: z.uuid() }).strict().nullable()
}).strict();
export type FieldPullCursor = z.infer<typeof cursorSchema>;
const scopeValue = (scope: Scope) => ({ organizationId: scope.organizationId, scopeType: scope.scopeType,
  scopeId: scope.scopeId, resourceType: scope.resourceType, resourceId: scope.resourceId });
const dateText = (value: Date | string | undefined | null) => value instanceof Date ? value.toISOString() : value;
export function fieldScopeStamp(ctx: AuthContext): string {
  const grants = assignmentCandidates(ctx).map(assignment => JSON.stringify({
    permissions: [...assignment.permissions].sort(), scope: scopeValue(assignment.scope),
    validFrom: dateText(assignment.validFrom), validTo: dateText(assignment.validTo),
    conditions: assignment.conditions ? { assignedToMe: assignment.conditions.assignedToMe,
      statuses: assignment.conditions.statuses ? [...assignment.conditions.statuses].sort() : undefined,
      maxAmount: assignment.conditions.maxAmount, timeWindow: assignment.conditions.timeWindow ? {
        startsAt: dateText(assignment.conditions.timeWindow.startsAt), endsAt: dateText(assignment.conditions.timeWindow.endsAt)
      } : undefined } : undefined
  })).sort();
  return createHash("sha256").update(JSON.stringify({ organizationId: ctx.organizationId, userId: ctx.userAccountId,
    personId: ctx.personId, permissions: [...ctx.permissions].sort(), grants })).digest("base64url");
}
function context(ctx: ReservationActorContext) { return `field-pull.v1:${ctx.organizationId}:${ctx.actorId}`; }
export function newFieldPullCursor(ctx: ReservationActorContext, input: FieldPullInput, now: Date): FieldPullCursor {
  const boundaries = assignmentCandidates(ctx.authContext).flatMap(assignment => [assignment.validFrom, assignment.validTo,
    assignment.conditions?.timeWindow?.startsAt, assignment.conditions?.timeWindow?.endsAt])
    .filter((value): value is Date | string => Boolean(value)).map(value => new Date(value).getTime())
    .filter(value => Number.isFinite(value) && value >= now.getTime());
  const expiry = Math.max(now.getTime() + 1, Math.min(now.getTime() + 300_000, ...boundaries));
  return { kind: "checkpoint", mode: input.mode, propertyId: input.property_id ?? null,
    scope: fieldScopeStamp(ctx.authContext), asOf: now.toISOString(), expiresAt: new Date(expiry).toISOString(), after: null };
}
export function encodeFieldPullCursor(value: FieldPullCursor, ctx: ReservationActorContext, env?: NodeJS.ProcessEnv): string {
  return encryptBytes(Buffer.from(JSON.stringify(value)), context(ctx), env).toString("base64url");
}
export function decodeFieldPullCursor(token: string, ctx: ReservationActorContext, input: FieldPullInput, now: Date, env?: NodeJS.ProcessEnv): FieldPullCursor {
  let value: FieldPullCursor;
  try {
    if (token.length > 2048 || !/^[a-zA-Z0-9_-]+$/u.test(token)) throw new Error("invalid_cursor");
    value = cursorSchema.parse(JSON.parse(decryptBytes(Buffer.from(token, "base64url"), context(ctx), env).toString("utf8")));
  } catch { throw new FieldPullError("invalid_cursor"); }
  if (value.mode !== input.mode || value.propertyId !== (input.property_id ?? null)) throw new FieldPullError("invalid_cursor");
  if (value.scope !== fieldScopeStamp(ctx.authContext)) throw new FieldPullError("reset_required");
  if ((value.kind === "page" || input.only_known) && new Date(value.expiresAt).getTime() <= now.getTime()) throw new FieldPullError("reset_required");
  if (input.only_known && value.kind !== "checkpoint") throw new FieldPullError("invalid_cursor");
  return value;
}
