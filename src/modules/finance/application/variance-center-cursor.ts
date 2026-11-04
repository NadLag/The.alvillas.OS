import { z } from "zod";
import { encryptBytes, decryptBytes } from "@/platform/auth/secret-encryption";
import { authorizationScopeStamp, authorizationCursorExpiry } from "@/platform/authz/authority-stamp";
import type { AuthContext } from "@/platform/authz/authorize";
import { commandFingerprint } from "@/platform/http/command-fingerprint";
import { VarianceCenterCursorError, varianceCenterFilterSchema, varianceCenterPositionSchema, type VarianceCenterFilter } from "../domain/variance-center";
import type { FinanceActorContext } from "./finance-access";

const cursorSchema = z.object({ schema: z.literal(1), filter: varianceCenterFilterSchema,
  held: z.string().min(1), current: z.string().min(1), issuedAt: z.iso.datetime(), expiresAt: z.iso.datetime(),
  after: varianceCenterPositionSchema }).strict();
const context = (ctx: FinanceActorContext) => `variance-center.v1:${ctx.organizationId}:${ctx.actorId}`;

export function encodeVarianceCenterCursor(ctx: FinanceActorContext, current: AuthContext, filter: VarianceCenterFilter,
  after: z.infer<typeof varianceCenterPositionSchema>, now: Date, env?: NodeJS.ProcessEnv) {
  const expiry = new Date(Math.min(authorizationCursorExpiry(ctx.authContext, now).getTime(), authorizationCursorExpiry(current, now).getTime()));
  const payload = cursorSchema.parse({ schema: 1, filter, held: authorizationScopeStamp(ctx.authContext), current: authorizationScopeStamp(current),
    after, issuedAt: now.toISOString(), expiresAt: expiry.toISOString() });
  return encryptBytes(Buffer.from(JSON.stringify(payload)), context(ctx), env).toString("base64url");
}

export function decodeVarianceCenterCursor(token: string, ctx: FinanceActorContext, current: AuthContext, filter: VarianceCenterFilter,
  now: Date, env?: NodeJS.ProcessEnv) {
  try {
    if (token.length > 8192 || !/^[a-zA-Z0-9_-]+$/u.test(token)) throw new VarianceCenterCursorError();
    const value = cursorSchema.parse(JSON.parse(decryptBytes(Buffer.from(token, "base64url"), context(ctx), env).toString("utf8")));
    if (commandFingerprint(value.filter) !== commandFingerprint(filter) || value.held !== authorizationScopeStamp(ctx.authContext) ||
        value.current !== authorizationScopeStamp(current) || new Date(value.issuedAt) > now || new Date(value.expiresAt) <= now) throw new VarianceCenterCursorError();
    return value.after;
  } catch { throw new VarianceCenterCursorError(); }
}
