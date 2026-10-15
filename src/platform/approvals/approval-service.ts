import { z } from "zod";
import { prisma } from "@/platform/db/client";
import { withTenant, type TenantTransactionRunner } from "@/platform/db/tenant";
import { authorize } from "@/platform/authz/authorize";
import { present } from "@/platform/authz/present";
import { writeAuditEvent } from "@/platform/audit/audit-writer";
import { NotificationRepository } from "@/platform/notifications/notification-repository";
import type { NotificationActor } from "@/platform/notifications/notification-service";
import { ApprovalRepository } from "./approval-repository";
import { ApprovalAccessError, ApprovalConflictError, approvalDecisionSchema, approvalRequestSchema, approvalResource } from "./approval";

type Deps = { db?: TenantTransactionRunner; requestId?: string };
function assertActor(actor: NotificationActor) {
  if (actor.authContext.organizationId !== actor.organizationId || actor.authContext.userAccountId !== actor.accountId) throw new ApprovalAccessError();
}
export async function getApprovalProperty(actor: NotificationActor, id: string, deps: Deps = {}) {
  z.string().uuid().parse(id); assertActor(actor);
  return withTenant(deps.db ?? prisma, actor.organizationId, async (tx) => {
    const property = await new ApprovalRepository(tx, actor.organizationId).property(id);
    if (!property || !authorize(actor.authContext, "view", { type: "property", organizationId: actor.organizationId, propertyId: id, region: property.regionId, city: property.cityId }) || !authorize(actor.authContext, "edit", { type: "property", organizationId: actor.organizationId, propertyId: id, region: property.regionId, city: property.cityId })) throw new ApprovalAccessError();
    return { id: property.id, name: property.name };
  });
}
export async function requestApproval(actor: NotificationActor, raw: unknown, deps: Deps = {}) {
  const input = approvalRequestSchema.parse(raw); assertActor(actor);
  return withTenant(deps.db ?? prisma, actor.organizationId, async (tx) => {
    const repository = new ApprovalRepository(tx, actor.organizationId);
    const notifications = new NotificationRepository(tx, actor.organizationId);
    const property = await repository.property(input.propertyId);
    if (!property || !await notifications.activeRecipient(actor.accountId) || !authorize(actor.authContext, "edit", { type: "property", organizationId: actor.organizationId, propertyId: property.id, region: property.regionId, city: property.cityId })) throw new ApprovalAccessError();
    await repository.lockKey(input.idempotencyKey);
    const existing = await repository.byKey(input.idempotencyKey);
    if (existing) {
      if (existing.requestedBy !== actor.accountId || existing.propertyId !== input.propertyId || existing.title !== input.title || existing.details !== input.details) throw new ApprovalConflictError();
      return { id: existing.id };
    }
    const routing = await notifications.routing("approval_requested", property.id);
    const recipients = await notifications.approvers(routing, { type: "property", organizationId: actor.organizationId, propertyId: property.id, region: property.regionId, city: property.cityId, status: "PENDING" });
    // Fail closed: an unconfigured request must never strand work without an approver.
    if (!recipients.length) throw new ApprovalConflictError();
    const row = await repository.create(input, actor.accountId, routing, recipients);
    await writeAuditEvent(tx, { organizationId: actor.organizationId, actorId: actor.accountId, action: "approval.requested", resourceType: "approval", resourceId: row.id,
      propertyScopeId: property.id, before: null, after: { state: row.state, recipientIds: recipients }, reason: input.details, requestId: deps.requestId ?? crypto.randomUUID(), occurredAt: row.createdAt });
    await notifications.publish({ kind: "approval_requested", recipientId: actor.accountId, targetId: row.id }, `approval:${row.id}:requested`);
    return { id: row.id };
  });
}
export async function getApproval(actor: NotificationActor, id: string, deps: Deps = {}) {
  z.string().uuid().parse(id); assertActor(actor);
  return withTenant(deps.db ?? prisma, actor.organizationId, async (tx) => {
    const row = await new ApprovalRepository(tx, actor.organizationId).find(id);
    if (!row || !await new NotificationRepository(tx, actor.organizationId).activeRecipient(actor.accountId) || !authorize(actor.authContext, "view", approvalResource(row))) throw new ApprovalAccessError();
    const selected = row.recipients.some((recipient) => recipient.userAccountId === actor.accountId);
    const data = { id: row.id, propertyName: row.property.name, title: row.title, details: row.details, state: row.state, decisionReason: row.decisionReason,
      canApprove: row.state === "PENDING" && selected && authorize(actor.authContext, "approve", approvalResource(row)),
      canReject: row.state === "PENDING" && selected && authorize(actor.authContext, "reject", approvalResource(row)) };
    return present({ ...actor.authContext, visibleDataClasses: new Set() }, "view", { ...approvalResource(row), data }, {}) as typeof data;
  });
}
export async function decideApproval(actor: NotificationActor, raw: unknown, deps: Deps = {}) {
  const input = approvalDecisionSchema.parse(raw); assertActor(actor);
  return withTenant(deps.db ?? prisma, actor.organizationId, async (tx) => {
    const repository = new ApprovalRepository(tx, actor.organizationId);
    const row = await repository.find(input.id, true);
    const action = input.decision === "APPROVED" ? "approve" : "reject";
    if (!row || !await new NotificationRepository(tx, actor.organizationId).activeRecipient(actor.accountId) || !row.recipients.some((recipient) => recipient.userAccountId === actor.accountId) || !authorize(actor.authContext, "view", approvalResource(row)) || !authorize(actor.authContext, action, approvalResource(row))) throw new ApprovalAccessError();
    if (row.state !== "PENDING") {
      if (row.state === input.decision && row.decidedBy === actor.accountId && row.decisionReason === input.reason) return;
      throw new ApprovalConflictError();
    }
    const now = new Date();
    await repository.decide(row.id, input.decision, actor.accountId, input.reason, now);
    await repository.resolveNotifications(row.id, input.decision, now);
    await writeAuditEvent(tx, { organizationId: actor.organizationId, actorId: actor.accountId, action: input.decision === "APPROVED" ? "approval.approved" : "approval.rejected", resourceType: "approval", resourceId: row.id,
      propertyScopeId: row.propertyId, before: { state: row.state }, after: { state: input.decision }, reason: input.reason, requestId: deps.requestId ?? crypto.randomUUID(), occurredAt: now });
    await new NotificationRepository(tx, actor.organizationId).publish({ kind: "approval_decided", recipientId: row.requestedBy, targetId: row.id }, `approval:${row.id}:decided`);
  });
}
