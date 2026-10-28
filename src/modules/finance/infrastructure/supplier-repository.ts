import { Prisma } from "@prisma/client";
import type { TenantTransaction } from "@/platform/db/tenant";
import { nextReferenceNumber } from "@/platform/references/reference-number";
import type { SupplierFields } from "../domain/supplier";

export class SupplierRepository {
  constructor(private readonly tx: TenantTransaction, private readonly organizationId: string) {}
  async lock(key: string) {
    await this.tx.$queryRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${this.organizationId + ":supplier:" + key},0))::text`);
  }
  find(id: string) { return this.tx.supplier.findFirst({ where: { organizationId: this.organizationId, id } }); }
  request(idempotencyKey: string) { return this.tx.supplier.findFirst({ where: { organizationId: this.organizationId, idempotencyKey } }); }
  list(input: { query?: string; category?: string; includeArchived?: boolean; after?: string }) {
    return this.tx.supplier.findMany({ where: { organizationId: this.organizationId, ...(input.includeArchived ? {} : { archivedAt: null }),
      ...(input.category ? { category: input.category } : {}), ...(input.after ? { id: { gt: input.after } } : {}),
      ...(input.query ? { OR: [{ displayName: { contains: input.query, mode: "insensitive" } }, { reference: { contains: input.query, mode: "insensitive" } }] } : {}) },
      orderBy: { id: "asc" }, take: 51 });
  }
  async create(fields: SupplierFields, input: { idempotencyKey: string; requestFingerprint: string; actorId: string }) {
    return this.tx.supplier.create({ data: { organizationId: this.organizationId, ...fields, idempotencyKey: input.idempotencyKey,
      requestFingerprint: input.requestFingerprint, reference: await nextReferenceNumber(this.tx, this.organizationId, "SUP"), createdBy: input.actorId } });
  }
  update(id: string, expectedVersion: number, fields: SupplierFields) {
    return this.tx.supplier.updateMany({ where: { organizationId: this.organizationId, id, version: expectedVersion, archivedAt: null }, data: { ...fields, version: { increment: 1 } } });
  }
  archive(id: string, expectedVersion: number, archivedAt: Date | null) {
    return this.tx.supplier.updateMany({ where: { organizationId: this.organizationId, id, version: expectedVersion }, data: { archivedAt, version: { increment: 1 } } });
  }
}
