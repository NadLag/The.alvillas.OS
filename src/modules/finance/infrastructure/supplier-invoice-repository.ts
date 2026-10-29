import { Prisma } from "@prisma/client";
import type { TenantTransaction } from "@/platform/db/tenant";
import { nextReferenceNumber } from "@/platform/references/reference-number";
import { supplierInvoiceTotal, type SupplierInvoiceFields } from "../domain/supplier-invoice";
import { SupplierPayableRepository } from "./supplier-payable-repository";

const revision = { lines: { orderBy: { position: "asc" as const }, include: { property: { select: { id: true, name: true, cityId: true, regionId: true, timezone: true, archivedAt: true } }, reservation: { select: { reference: true, status: true, createdBy: true } } } } } satisfies Prisma.SupplierInvoiceRevisionInclude;
const include = { supplier: { select: { id: true, reference: true, displayName: true, archivedAt: true } }, currentRevision: { include: revision } } satisfies Prisma.SupplierInvoiceInclude;
export class SupplierInvoiceRepository {
  constructor(private readonly tx: TenantTransaction, private readonly organizationId: string) {}
  lock(id: string) { return new SupplierPayableRepository(this.tx, this.organizationId).lockInvoice(id); }
  find(id: string) { return this.tx.supplierInvoice.findFirst({ where: { organizationId: this.organizationId, id }, include }); }
  byKey(idempotencyKey: string) { return this.tx.supplierInvoice.findFirst({ where: { organizationId: this.organizationId, idempotencyKey }, include }); }
  currency(code: string) { return this.tx.currency.findUnique({ where: { code }, select: { code: true, minorUnit: true } }); }
  properties(ids: string[]) { return this.tx.property.findMany({ where: { organizationId: this.organizationId, id: { in: ids }, archivedAt: null }, select: { id: true, name: true, cityId: true, regionId: true } }); }
  reservations(ids: string[]) { return this.tx.reservation.findMany({ where: { organizationId: this.organizationId, id: { in: ids }, archivedAt: null }, select: { id: true, propertyId: true, reference: true, status: true, createdBy: true } }); }
  supplierChoices(query: string) { return this.tx.supplier.findMany({ where: { organizationId: this.organizationId, archivedAt: null, ...(query ? { OR: [{ displayName: { contains: query, mode: "insensitive" } }, { reference: { contains: query, mode: "insensitive" } }] } : {}) }, select: { id: true, displayName: true, category: true }, orderBy: { id: "asc" } }); }
  propertyChoices(query: string) { return this.tx.property.findMany({ where: { organizationId: this.organizationId, archivedAt: null, ...(query ? { OR: [{ name: { contains: query, mode: "insensitive" } }, { city: { contains: query, mode: "insensitive" } }] } : {}) }, select: { id: true, name: true, city: true, addressLine1: true, cityId: true, regionId: true }, orderBy: { id: "asc" } }); }
  reservationChoices(propertyId: string, query: string) { return this.tx.reservation.findMany({ where: { organizationId: this.organizationId, propertyId, archivedAt: null, ...(query ? { reference: { contains: query, mode: "insensitive" } } : {}) }, select: { id: true, reference: true, status: true, propertyId: true, createdBy: true }, orderBy: { id: "asc" } }); }
  async identities() {
    const [row] = await this.tx.$queryRaw<Array<{ id: string; revisionId: string }>>(Prisma.sql`SELECT app_uuid_v7()::text AS id,app_uuid_v7()::text AS "revisionId"`); return row;
  }
  list(input: { query?: string; supplierId?: string; includeArchived?: boolean; after?: string }) {
    return this.tx.supplierInvoice.findMany({ where: { organizationId: this.organizationId, ...(input.includeArchived ? {} : { archivedAt: null }),
      ...(input.supplierId ? { supplierId: input.supplierId } : {}), ...(input.after ? { id: { gt: input.after } } : {}),
      ...(input.query ? { OR: [{ reference: { contains: input.query, mode: "insensitive" } }, { invoiceNumber: { contains: input.query, mode: "insensitive" } }] } : {}) },
      orderBy: { id: "asc" }, take: 51, include });
  }
  history(invoiceId: string, beforeVersion?: number) {
    return this.tx.supplierInvoiceRevision.findMany({ where: { organizationId: this.organizationId, invoiceId, ...(beforeVersion === undefined ? {} : { version: { lt: beforeVersion } }) },
      orderBy: { version: "desc" }, take: 51, select: { id: true, version: true, invoiceNumber: true, amount: true, currency: true, createdAt: true, createdBy: true, issuedOn: true, dueOn: true, reason: true } });
  }
  revision(invoiceId: string, id: string) { return this.tx.supplierInvoiceRevision.findFirst({ where: { organizationId: this.organizationId, invoiceId, id }, include: revision }); }
  async create(input: { id: string; revisionId: string; supplierId: string; invoiceNumber: string; idempotencyKey: string; requestFingerprint: string; actorId: string }) {
    return this.tx.supplierInvoice.create({ data: { organizationId: this.organizationId, id: input.id, supplierId: input.supplierId,
      reference: await nextReferenceNumber(this.tx, this.organizationId, "SINV"), invoiceNumber: input.invoiceNumber, currentRevisionId: input.revisionId,
      idempotencyKey: input.idempotencyKey, requestFingerprint: input.requestFingerprint, createdBy: input.actorId, updatedBy: input.actorId } });
  }
  createRevision(input: { id: string; invoiceId: string; version: number; fields: SupplierInvoiceFields; actorId: string; reason: string }) {
    const { lines, dueOn, issuedOn, ...fields } = input.fields;
    return this.tx.supplierInvoiceRevision.create({ data: { organizationId: this.organizationId, id: input.id, invoiceId: input.invoiceId, version: input.version,
      ...fields, issuedOn: new Date(issuedOn + "T00:00:00.000Z"), dueOn: dueOn ? new Date(dueOn + "T00:00:00.000Z") : null,
      amount: supplierInvoiceTotal(input.fields).toJSON().amount, createdBy: input.actorId, reason: input.reason,
      lines: { create: lines.map((line, index) => ({ ...line, position: index + 1, currency: fields.currency, createdBy: input.actorId })) } }, include: revision });
  }
  pointToRevision(input: { id: string; expectedVersion: number; revisionId: string; invoiceNumber: string; actorId: string }) {
    return this.tx.supplierInvoice.updateMany({ where: { organizationId: this.organizationId, id: input.id, version: input.expectedVersion, state: "DRAFT", archivedAt: null },
      data: { invoiceNumber: input.invoiceNumber, currentRevisionId: input.revisionId, version: { increment: 1 }, updatedBy: input.actorId } });
  }
  archive(id: string, expectedVersion: number, archivedAt: Date | null, actorId: string) {
    return this.tx.supplierInvoice.updateMany({ where: { organizationId: this.organizationId, id, version: expectedVersion, state: "DRAFT" }, data: { archivedAt, version: { increment: 1 }, updatedBy: actorId } });
  }
}
export type SupplierInvoiceRecord = NonNullable<Awaited<ReturnType<SupplierInvoiceRepository["find"]>>>;
