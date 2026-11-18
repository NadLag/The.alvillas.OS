import { z } from "zod";
import { approvalDecisionSchema, ApprovalAccessError } from "@/platform/approvals/approval";
import { decideApproval, getApproval } from "@/platform/approvals/approval-service";
import type { NotificationActor } from "@/platform/notifications/notification-service";
import { prisma } from "@/platform/db/client";
import { withTenant, type TenantTransactionRunner } from "@/platform/db/tenant";
import { OwnerApprovalRepository } from "../infrastructure/owner-approval-repository";
import { OwnerPortalRepository } from "../infrastructure/owner-portal-repository";
import type { OwnerPortalActorContext } from "./owner-portal-access";
import { OwnerPortalNotFoundError } from "./owner-portal-service";

export const ownerApprovalSelection = z.strictObject({ id: z.uuid(), stageId: z.uuid() });
type Selection = z.infer<typeof ownerApprovalSelection>;

function assertOwnerScope(owner: OwnerPortalActorContext, actor: NotificationActor, propertyId: string) {
  if (owner.organizationId !== actor.organizationId || owner.actorId !== actor.accountId || !owner.propertyIds.includes(propertyId))
    throw new OwnerPortalNotFoundError();
}

export async function loadOwnerApprovals(owner: OwnerPortalActorContext, actor: NotificationActor, propertyId: string,
  selection?: Selection, after?: string, db: TenantTransactionRunner = prisma) {
  assertOwnerScope(owner, actor, propertyId);
  return withTenant(db, owner.organizationId, async tx => {
    const [property, rows] = await Promise.all([
      new OwnerPortalRepository(tx, owner.organizationId).findOwnerPropertyAccess(owner.actorId, propertyId),
      new OwnerApprovalRepository(tx, owner.organizationId).pending(owner.actorId, propertyId, selection, after)
    ]);
    if (!property) throw new OwnerPortalNotFoundError();
    const items = [];
    for (const row of rows.slice(0,25)) {
      try {
        const native = await getApproval(actor, row.approvalId, { db: { $transaction: work => work(tx) },
          stageId: row.source === "invoice" ? row.stageId : undefined });
        if (native.stageId === row.stageId && (native.canApprove || native.canReject) && native.financial) {
          items.push({ ...row, approval: { ...native, title: "", details: "", decisionReason: null, history: [], historyNext: undefined,
            financial: { ...native.financial, amount: row.amount, currency: row.currency } } });
        }
      } catch (error) { if (!(error instanceof ApprovalAccessError)) throw error; }
    }
    if (selection && items.length === 0) throw new OwnerPortalNotFoundError();
    return { items, property: property.propertyName, next: !selection && rows.length > 25 ? rows[24].stageId : undefined };
  });
}

export async function decideOwnerApproval(owner: OwnerPortalActorContext, actor: NotificationActor, property: string, raw: unknown,
  db: TenantTransactionRunner = prisma) {
  const propertyId = z.uuid().parse(property), decision = approvalDecisionSchema.parse(raw);
  assertOwnerScope(owner, actor, propertyId);
  if (!decision.stageId) throw new ApprovalAccessError();
  const selection = { id: decision.id, stageId: decision.stageId };
  await withTenant(db, owner.organizationId, async tx => {
    const repository = new OwnerApprovalRepository(tx, owner.organizationId);
    const [stage] = await repository.pending(owner.actorId, propertyId, selection, undefined, true);
    if (!stage) throw new ApprovalAccessError();
    await decideApproval(actor, decision, { db: { $transaction: work => work(tx) } });
    const ownership = await new OwnerPortalRepository(tx, owner.organizationId).listOwnerProperties(owner.actorId);
    if (!ownership.some(row => row.propertyId === propertyId && row.ownerId === stage.ownerId)) throw new ApprovalAccessError();
  });
}
