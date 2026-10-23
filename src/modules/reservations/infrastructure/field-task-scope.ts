import type { Prisma } from "@prisma/client";
import { z } from "zod";
import { assignmentCandidates, conditionsMatch, scopeId, scopeType, type AuthContext, type Scope } from "@/platform/authz/authorize";

const uuid = (value: string) => z.uuid().safeParse(value).success;
function scopeWhere(scope: Scope): Prisma.OperationTaskWhereInput | null {
  const id = scopeId(scope);
  switch (scopeType(scope)) {
    case "organization": return {};
    case "city": return !id ? {} : { property: { OR: [...(uuid(id) ? [{ cityId: id }] : []), { cityId: null, city: id }] } };
    case "region": return !id ? {} : { property: { OR: [...(uuid(id) ? [{ regionId: id }] : []), { regionId: null, region: id }] } };
    case "property": return !id ? {} : uuid(id) ? { OR: [{ propertyId: id }, { id }] } : null;
    case "reservation": return !id ? {} : uuid(id) ? { OR: [{ reservationId: id }, { id }] } : null;
    case "job": case "owner": case "service": case "financial_record": case "wallet": return !id ? {} : uuid(id) ? { id } : null;
    case "field_team": return !id ? {} : null;
    default: return !scope.scopeType && scope.resourceType === "task" ? !id ? {} : uuid(id) ? { id } : null : null;
  }
}

/** SQL adapter for the same assignment scopes and conditions used by authorize(). */
export function fieldTaskReadWhere(ctx: AuthContext, at: Date): Prisma.OperationTaskWhereInput {
  if (!ctx.permissions.has("task:view")) return { OR: [] };
  const grants: Prisma.OperationTaskWhereInput[] = [];
  for (const assignment of assignmentCandidates(ctx)) {
    if (assignment.scope.organizationId !== ctx.organizationId || !assignment.permissions.has("task:view")) continue;
    if (!conditionsMatch(ctx, assignment, { type: "task", organizationId: ctx.organizationId,
      assignedUserAccountId: ctx.userAccountId, assignedPersonId: ctx.personId, status: assignment.conditions?.statuses?.[0] }, at)) continue;
    const where = scopeWhere(assignment.scope);
    if (!where) continue;
    const constraints: Prisma.OperationTaskWhereInput[] = [where];
    if (assignment.conditions?.statuses?.length) constraints.push({ state: { in: [...assignment.conditions.statuses] } });
    if (assignment.conditions?.assignedToMe) constraints.push({ OR: [
      ...(ctx.userAccountId ? [{ assignedToUserAccountId: ctx.userAccountId }] : []),
      ...(ctx.personId ? [{ assignedToPersonId: ctx.personId }] : [])
    ] });
    grants.push({ AND: constraints });
  }
  return { OR: grants };
}
