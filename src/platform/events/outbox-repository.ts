import { Prisma } from "@prisma/client";
import type { TenantTransaction, TenantTransactionRunner } from "@/platform/db/tenant";
import { outboxDispatchEvent } from "./outbox";

export type OutboxDatabase = TenantTransactionRunner & {
  organization: { findMany(args: { select: { id: true }; orderBy: { createdAt: "asc" } }): Promise<Array<{ id: string }>> };
};

export class OutboxRepository {
  constructor(private readonly tx: TenantTransaction, private readonly organizationId: string) {}

  // The HTTP drain and Inngest runs share this lock, including across processes.
  async lockDispatcher() {
    await this.tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${`outbox:${this.organizationId}`}, 0))`);
  }

  due(now: Date, limit: number) {
    return this.tx.outboxEvent.findMany({ where: { organizationId: this.organizationId, status: "PENDING",
      OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }] }, orderBy: { occurredAt: "asc" }, take: limit });
  }

  event(id: string) {
    return this.tx.outboxEvent.findFirst({ where: { organizationId: this.organizationId, id } });
  }

  requestDispatch(idempotencyKey: string) {
    return this.tx.outboxEvent.upsert({ where: { organizationId_idempotencyKey: { organizationId: this.organizationId, idempotencyKey } },
      update: {}, create: { organizationId: this.organizationId, type: outboxDispatchEvent, payload: {}, idempotencyKey } });
  }

  update(id: string, data: Prisma.OutboxEventUpdateInput) {
    return this.tx.outboxEvent.update({ where: { id, organizationId: this.organizationId }, data });
  }

  static organizations(db: OutboxDatabase) {
    return db.organization.findMany({ select: { id: true }, orderBy: { createdAt: "asc" } });
  }
}
