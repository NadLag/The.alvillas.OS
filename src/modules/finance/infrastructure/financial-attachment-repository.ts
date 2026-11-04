import { Prisma } from "@prisma/client";
import { FinancialAttachmentSourceRepository } from "@/platform/ledger/financial-attachment-source-repository";

export class FinancialAttachmentRepository extends FinancialAttachmentSourceRepository {
  async clock() { const [row] = await this.tx.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`; return row.now; }
  async lock(transactionId: string) { await this.tx.$queryRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${this.organizationId + ":financial-attachment:" + transactionId},0))::text`); }
  admission(id: string) { return this.tx.financialAttachmentAdmission.findFirst({ where: { organizationId: this.organizationId, id }, include: { attachment: true, supersedes: true } }); }
  byNonce(createdBy: string, idempotencyKey: string) { return this.tx.financialAttachmentAdmission.findFirst({ where: { organizationId: this.organizationId, createdBy, idempotencyKey }, include: { attachment: true, supersedes: true } }); }
  attachment(id: string) { return this.tx.financialAttachment.findFirst({ where: { organizationId: this.organizationId, id }, include: { admission: true, next: { select: { id: true } } } }); }
  appendAdmission(data: Omit<Prisma.FinancialAttachmentAdmissionUncheckedCreateInput, "organizationId">) {
    return this.tx.financialAttachmentAdmission.create({ data: { ...data, organizationId: this.organizationId }, include: { attachment: true, supersedes: true } });
  }
  appendAttachment(data: Omit<Prisma.FinancialAttachmentUncheckedCreateInput, "organizationId">) {
    return this.tx.financialAttachment.create({ data: { ...data, organizationId: this.organizationId } });
  }
  history(transactionId: string, before?: string) { return this.tx.financialAttachment.findMany({ where: { organizationId: this.organizationId, transactionId, ...(before ? { id: { lt: before } } : {}) },
    include: { admission: true, next: { select: { id: true } } }, orderBy: { id: "desc" }, take: 31 }); }
  candidates(query: string, before?: string) { return this.tx.financialTransaction.findMany({ where: { organizationId: this.organizationId, sealed: true, reference: { contains: query, mode: "insensitive" },
    ...(before ? { id: { lt: before } } : {}) }, select: { id: true }, orderBy: { id: "desc" }, take: 31 }); }
}
