import { createHash } from "node:crypto";
import { assignmentCandidates, type AuthContext, type Scope } from "./authorize";

const scopeValue = (scope: Scope) => ({ organizationId: scope.organizationId, scopeType: scope.scopeType,
  scopeId: scope.scopeId, resourceType: scope.resourceType, resourceId: scope.resourceId });
const dateText = (value: Date | string | undefined | null) => value instanceof Date ? value.toISOString() : value;

/** Preserve the field cursor's canonical restriction stamp across every private continuation. */
export function authorizationScopeStamp(ctx: AuthContext): string {
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

/** The established five-minute cursor fence is also bounded by every stored grant transition. */
export function authorizationCursorExpiry(ctx: AuthContext, now: Date): Date {
  const boundaries = assignmentCandidates(ctx).flatMap(assignment => [assignment.validFrom, assignment.validTo,
    assignment.conditions?.timeWindow?.startsAt, assignment.conditions?.timeWindow?.endsAt])
    .filter((value): value is Date | string => Boolean(value)).map(value => new Date(value).getTime())
    .filter(value => Number.isFinite(value) && value >= now.getTime());
  return new Date(Math.max(now.getTime() + 1, Math.min(now.getTime() + 300_000, ...boundaries)));
}
