import { Prisma } from "@prisma/client";
import type { AuthorizationCap } from "@/platform/authz/authorization-cap";
import type { TenantTransaction } from "@/platform/db/tenant";

export type RecognitionOutcomeState = "SUCCEEDED" | "DENIED" | "CONFLICT" | "FAILED";
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
  create(input: { invoiceId: string; submissionId: string; invoiceVersion: number; currentPeriod: boolean; idempotencyKey: string;
    requestFingerprint: string; reason: string; authorizationCap: AuthorizationCap; requestedBy: string }) {
    return this.tx.supplierInvoiceRecognitionRequest.create({ data: { organizationId: this.organizationId, ...input,
      authorizationCap: input.authorizationCap } });
  }
  outcome(input: { id: string; requestId: string; state: RecognitionOutcomeState; recognitionId: string | null; failureCode: string | null }) {
    return this.tx.supplierInvoiceRecognitionOutcome.create({ data: { organizationId: this.organizationId, ...input } });
  }
  async flushGuards() { await this.tx.$executeRawUnsafe("SET CONSTRAINTS ALL IMMEDIATE"); }
}
