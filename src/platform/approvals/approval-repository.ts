import { Prisma } from "@prisma/client";
import type { TenantTransaction } from "@/platform/db/tenant";
import type { z } from "zod";
import type { approvalRequestSchema } from "./approval";

export class ApprovalRepository {
  constructor(private readonly tx: TenantTransaction, private readonly organizationId: string) {}
  property(id: string) {
    return this.tx.property.findFirst({ where: { organizationId: this.organizationId, id, archivedAt: null }, select: { id: true, name: true, regionId: true, cityId: true } });
  }
  async lockKey(key: string) {
    await this.tx.$queryRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${this.organizationId + ":approval:" + key}, 0))::text`);
  }
  byKey(key: string) { return this.tx.approvalRequest.findFirst({ where: { organizationId: this.organizationId, idempotencyKey: key }, include: { property: true, recipients: true } }); }
  async find(id: string, lock = false) {
    if (lock) await this.tx.$queryRaw(Prisma.sql`SELECT id FROM approval_request WHERE organization_id = ${this.organizationId}::uuid AND id = ${id}::uuid FOR UPDATE`);
    return this.tx.approvalRequest.findFirst({ where: { organizationId: this.organizationId, id, property: { archivedAt: null } }, include: { property: true, recipients: true } });
  }
  async create(input: z.infer<typeof approvalRequestSchema>, requestedBy: string, routing: Prisma.InputJsonObject, recipients: string[]) {
    const row = await this.tx.approvalRequest.create({ data: { organizationId: this.organizationId, ...input, requestedBy, routingSnapshot: routing }, include: { property: true } });
    await this.tx.approvalRecipient.createMany({ data: recipients.map((userAccountId) => ({ organizationId: this.organizationId, approvalId: row.id, userAccountId })) });
    return row;
  }
  decide(id: string, state: "APPROVED" | "REJECTED", decidedBy: string, decisionReason: string, decidedAt: Date) {
    return this.tx.approvalRequest.update({ where: { id, organizationId: this.organizationId }, data: { state, decidedBy, decisionReason, decidedAt } });
  }
  async resolveNotifications(id: string, resolution: string, resolvedAt: Date) {
    await this.tx.notification.updateMany({ where: { organizationId: this.organizationId, targetId: id, kind: "approval_requested", resolvedAt: null }, data: { resolution, resolvedAt } });
    await this.tx.notification.updateMany({ where: { organizationId: this.organizationId, targetId: id, kind: "approval_requested", readAt: null }, data: { readAt: resolvedAt } });
  }
}
