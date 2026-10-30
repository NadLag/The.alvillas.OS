import { z } from "zod";
import type { AuthContext, AuthAssignment } from "./authorize";

const scope = z.object({ organizationId: z.uuid(), scopeType: z.enum(["organization", "region", "city", "property", "owner", "reservation", "job", "service", "financial_record", "wallet", "field_team"]).optional(),
  scopeId: z.string().optional(), resourceType: z.string().optional(), resourceId: z.string().optional() }).strict();
const instant = z.iso.datetime({ offset: true });
const conditions = z.object({ assignedToMe: z.boolean().optional(), statuses: z.array(z.string()).optional(), maxAmount: z.union([z.string(), z.number().finite()]).optional(),
  timeWindow: z.object({ startsAt: instant.optional(), endsAt: instant.optional() }).strict().optional() }).strict();
const assignment = z.object({ roleKey: z.string().optional(), permissions: z.array(z.string()), scope, conditions: conditions.optional(),
  validFrom: instant.optional(), validTo: instant.nullable().optional() }).strict();

/** An immutable request restriction, always intersected with freshly loaded stored authority by the financial service. */
export const authorizationCapSchema = z.object({ schemaVersion: z.literal(1), organizationId: z.uuid(), userAccountId: z.uuid(), personId: z.uuid().optional(),
  permissions: z.array(z.string()), scopes: z.array(scope), assignments: z.array(assignment).optional() }).strict().superRefine((value, ctx) => {
  if ([...value.scopes, ...(value.assignments ?? []).map(item => item.scope)].some(item => item.organizationId !== value.organizationId))
    ctx.addIssue({ code: "custom", path: ["scopes"], message: "Request restrictions must belong to their actual organization" });
});
export type AuthorizationCap = z.infer<typeof authorizationCapSchema>;
const iso = (value: Date | string | undefined) => value === undefined ? undefined : value instanceof Date ? value.toISOString() : value;

export function captureAuthorizationCap(ctx: AuthContext): AuthorizationCap {
  return authorizationCapSchema.parse({ schemaVersion: 1, organizationId: ctx.organizationId, userAccountId: ctx.userAccountId, personId: ctx.personId,
    permissions: [...ctx.permissions].sort(), scopes: ctx.scopes, assignments: ctx.assignments?.map(item => ({ ...item,
      permissions: [...item.permissions].sort(), validFrom: iso(item.validFrom), validTo: item.validTo === null ? null : iso(item.validTo),
      conditions: item.conditions ? { ...item.conditions, timeWindow: item.conditions.timeWindow ? {
        startsAt: iso(item.conditions.timeWindow.startsAt), endsAt: iso(item.conditions.timeWindow.endsAt) } : undefined } : undefined })) });
}

export function restoreAuthorizationCap(raw: unknown): AuthContext {
  const value = authorizationCapSchema.parse(raw);
  const assignments: AuthAssignment[] | undefined = value.assignments?.map(item => ({ ...item, permissions: new Set(item.permissions),
    scope: item.scope, validFrom: item.validFrom === undefined ? undefined : new Date(item.validFrom),
    validTo: item.validTo === null ? null : item.validTo === undefined ? undefined : new Date(item.validTo) }));
  return { organizationId: value.organizationId, userAccountId: value.userAccountId, personId: value.personId,
    permissions: new Set(value.permissions), scopes: value.scopes, assignments };
}
