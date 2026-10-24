import { z } from "zod";
import { withTenant } from "@/platform/db/tenant";
import { prisma } from "@/platform/db/client";
import { authorize } from "@/platform/authz/authorize";
import type { ReservationActorContext } from "./reservation-access";
import { OperationRepository } from "../infrastructure/operation-repository";
import { operationAllowed, operationScope, taskResource, type OperationDeps } from "./operation-service";

/** Both capabilities must cover the actual record before pagination. */
export async function fieldProxyTasks(ctx: ReservationActorContext, input: unknown, deps: OperationDeps = {}) {
  operationAllowed(ctx, "view"); operationAllowed(ctx, "validate");
  const { page, search } = z.object({ page: z.number().int().min(1).max(10000), search: z.string().trim().max(120).default("") }).strict().parse(input);
  return withTenant(deps.db ?? prisma, ctx.organizationId, async tx => {
    const repo = new OperationRepository(tx, ctx.organizationId), properties = await repo.properties();
    const view = await operationScope(ctx, "view", repo, properties), validate = await operationScope(ctx, "validate", repo, properties);
    if (!view.groups.length || !validate.groups.length) return { page, size: 50, count: 0, tasks: [] };
    const where = { AND: [{ OR: view.groups }, { OR: validate.groups }, ...(search ? [{ property: { name: { contains: search, mode: "insensitive" as const } } }] : []), { state: { in: ["ASSIGNED", "IN_PROGRESS"] } },
      { assignedToPersonId: { not: null } }, { NOT: { assignedToPersonId: ctx.personId } },
      { OR: [{ assignedToUserAccountId: null }, { assignedToUserAccountId: { not: ctx.actorId } }] }] };
    const size = 50, [rows, count] = await Promise.all([repo.page(where, (page - 1) * size, size), repo.count(where)]);
    return { page, size, count, tasks: rows.filter(task => authorize(ctx.authContext, "view", taskResource(task)) &&
      authorize(ctx.authContext, "validate", taskResource(task))).map(task => ({ id: task.id, title: task.titleTranslations,
      propertyName: task.property.name, dueDate: task.dueDate })) };
  });
}
