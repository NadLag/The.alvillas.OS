import { Prisma } from "@prisma/client";
import type { TenantTransaction } from "@/platform/db/tenant";
import type { z } from "zod";
import type { approvalRequestSchema } from "./approval";
import { SupplierPayableRepository } from "@/modules/finance/infrastructure/supplier-payable-repository";

const include = { property: true, recipients: true, expense: true, invoiceSubmission: { include: { invoice: true } },
  financialStages: { orderBy: { position: "asc" as const }, include: { recipients: true, property: { select: { name: true, cityId: true, regionId: true } } } } } satisfies Prisma.ApprovalRequestInclude;

export type FinancialApprovalStageDraft = { kind: string; ownerId: string | null; amount: string; currency: string; routing: Prisma.InputJsonObject; recipients: string[];
  lineId?: string; propertyId?: string | null; reservationId?: string | null; sourceSnapshot?: Prisma.InputJsonObject };
type FinancialApprovalInput = { requestedBy: string; title: string; details: string; stages: FinancialApprovalStageDraft[] } &
  ({ expenseId: string; propertyId: string; invoiceSubmissionId?: never } | { invoiceSubmissionId: string; propertyId: null; expenseId?: never });

export class ApprovalRepository {
  constructor(private readonly tx: TenantTransaction, private readonly organizationId: string) {}
  property(id: string) {
    return this.tx.property.findFirst({ where: { organizationId: this.organizationId, id, archivedAt: null }, select: { id: true, name: true, regionId: true, cityId: true } });
  }
  async lockKey(key: string) {
    await this.tx.$queryRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${this.organizationId + ":approval:" + key}, 0))::text`);
  }
  byKey(key: string) { return this.tx.approvalRequest.findFirst({ where: { organizationId: this.organizationId, idempotencyKey: key }, include }); }
  async find(id: string, lock = false) {
    if (lock) await this.tx.$queryRaw(Prisma.sql`SELECT id FROM approval_request WHERE organization_id = ${this.organizationId}::uuid AND id = ${id}::uuid FOR UPDATE`);
    return this.tx.approvalRequest.findFirst({ where: { organizationId: this.organizationId, id,
      OR: [{ invoiceSubmissionId: { not: null } }, { invoiceSubmissionId: null, property: { archivedAt: null } }] }, include });
  }
  async clock() {
    const [row] = await this.tx.$queryRaw<Array<{ now: Date }>>(Prisma.sql`SELECT date_trunc('milliseconds',clock_timestamp()) AS now`); return row.now;
  }
  async lockExpense(id: string) {
    await this.tx.$queryRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${this.organizationId + ":expense:" + id},0))::text`);
  }
  lockInvoice(id: string) { return new SupplierPayableRepository(this.tx, this.organizationId).lockInvoice(id); }
  async createFinancial(input: FinancialApprovalInput) {
    if (!input.stages.length || Boolean(input.expenseId) === Boolean(input.invoiceSubmissionId)) throw Error("Financial approval requires one source and its configured stages");
    const row = await this.tx.approvalRequest.create({ data: { organizationId: this.organizationId, expenseId: input.expenseId, invoiceSubmissionId: input.invoiceSubmissionId,
      propertyId: input.propertyId, requestedBy: input.requestedBy, title: input.title, details: input.details,
      idempotencyKey: input.expenseId ? `expense:${input.expenseId}:approval` : `supplier-invoice-submission:${input.invoiceSubmissionId}:approval`, routingSnapshot: input.stages[0].routing } });
    await this.tx.approvalRecipient.createMany({ data: [...new Set(input.stages.flatMap(stage => stage.recipients))].map(userAccountId =>
      ({ organizationId: this.organizationId, approvalId: row.id, userAccountId })) });
    for (const [index, stage] of input.stages.entries()) {
      const saved = await this.tx.approvalStage.create({ data: {
      organizationId: this.organizationId, approvalId: row.id, position: index + 1, kind: stage.kind, ownerId: stage.ownerId,
      amount: stage.amount, currency: stage.currency, routingSnapshot: stage.routing, invoiceLineId: stage.lineId,
      propertyId: stage.propertyId, reservationId: stage.reservationId, sourceSnapshot: stage.sourceSnapshot } });
      await this.tx.approvalStageRecipient.createMany({ data: stage.recipients.map(userAccountId => ({ organizationId: this.organizationId, stageId: saved.id, userAccountId })) });
    }
    return this.find(row.id);
  }
  decideStage(id: string, state: "APPROVED" | "REJECTED" | "CANCELLED", decidedBy: string, decisionReason: string, decidedAt: Date) {
    return this.tx.approvalStage.updateMany({ where: { id, organizationId: this.organizationId, state: "PENDING" }, data: { state, decidedBy, decisionReason, decidedAt } });
  }
  async create(input: z.infer<typeof approvalRequestSchema>, requestedBy: string, routing: Prisma.InputJsonObject, recipients: string[]) {
    const row = await this.tx.approvalRequest.create({ data: { organizationId: this.organizationId, ...input, requestedBy, routingSnapshot: routing }, include: { property: true } });
    await this.tx.approvalRecipient.createMany({ data: recipients.map((userAccountId) => ({ organizationId: this.organizationId, approvalId: row.id, userAccountId })) });
    return row;
  }
  decide(id: string, state: "APPROVED" | "REJECTED", decidedBy: string, decisionReason: string, decidedAt: Date) {
    return this.tx.approvalRequest.update({ where: { id, organizationId: this.organizationId }, data: { state, decidedBy, decisionReason, decidedAt } });
  }
  event(type: "ApprovalRequested" | "ApprovalDecided", approvalId: string, propertyId: string | null) {
    const key=`approval:${approvalId}:${type}`;
    return this.tx.outboxEvent.upsert({where:{organizationId_idempotencyKey:{organizationId:this.organizationId,idempotencyKey:key}},update:{},create:{organizationId:this.organizationId,type,payload:{approvalId,...(propertyId?{propertyId}:{})},idempotencyKey:key}});
  }
  async resolveNotifications(id: string, resolution: string, resolvedAt: Date) {
    await this.tx.notification.updateMany({ where: { organizationId: this.organizationId, targetId: id, kind: "approval_requested", resolvedAt: null }, data: { resolution, resolvedAt } });
    await this.tx.notification.updateMany({ where: { organizationId: this.organizationId, targetId: id, kind: "approval_requested", readAt: null }, data: { readAt: resolvedAt } });
  }
}
