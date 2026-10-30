import { Prisma } from "@prisma/client";
import type { AuthorizationCap } from "@/platform/authz/authorization-cap";
import type { TenantTransaction } from "@/platform/db/tenant";

export type RecognitionOutcomeState = "SUCCEEDED" | "DENIED" | "CONFLICT" | "FAILED";
export type SupplierInvoiceFinancialOperation = "RECOGNIZE" | "REVERSE";
export class SupplierInvoiceRecognitionRequestRepository {
  constructor(private readonly tx: TenantTransaction, private readonly organizationId: string) {}
  async lockRequest(id: string) {
    await this.tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${`invoice-recognition-request:${this.organizationId}:${id}`}, 0))`);
  }
  async lockKey(key: string) {
    await this.tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${`invoice-recognition-key:${this.organizationId}:${key}`}, 0))`);
  }
  find(id: string) { return this.tx.supplierInvoiceRecognitionRequest.findFirst({ where: { organizationId: this.organizationId, id }, include: { outcome: true } }); }
  byKey(idempotencyKey: string) { return this.tx.supplierInvoiceRecognitionRequest.findFirst({ where: { organizationId: this.organizationId, idempotencyKey }, include: { outcome: true } }); }
  history(invoiceId: string, before?: string, operation: SupplierInvoiceFinancialOperation = "RECOGNIZE") {
    return this.tx.supplierInvoiceRecognitionRequest.findMany({ where: { organizationId: this.organizationId, invoiceId, operation, ...(before ? { id: { lt: before } } : {}) },
      orderBy: { id: "desc" }, take: 51, select: { id: true, reason: true, requestedAt: true, currentPeriod: true,
        outcome: { select: { state: true, occurredAt: true, failureCode: true } } } });
  }
  pending(invoiceId: string, operation: SupplierInvoiceFinancialOperation = "RECOGNIZE") {
    return this.tx.supplierInvoiceRecognitionRequest.findFirst({ where: { organizationId: this.organizationId, invoiceId, operation, outcome: null }, select: { id: true } });
  }
  create(input: { invoiceId: string; submissionId: string; invoiceVersion: number; currentPeriod: boolean; idempotencyKey: string;
    requestFingerprint: string; reason: string; authorizationCap: AuthorizationCap; requestedBy: string; operation?: SupplierInvoiceFinancialOperation }) {
    return this.tx.supplierInvoiceRecognitionRequest.create({ data: { organizationId: this.organizationId, ...input,
      authorizationCap: input.authorizationCap } });
  }
  async outcome(input: { id: string; requestId: string; state: RecognitionOutcomeState; recognitionId: string | null; failureCode: string | null }) {
    return await this.tx.supplierInvoiceRecognitionOutcome.create({ data: { organizationId: this.organizationId, ...input } });
  }
  async flushGuards() { await this.tx.$executeRawUnsafe("SET CONSTRAINTS ALL IMMEDIATE"); }
}
