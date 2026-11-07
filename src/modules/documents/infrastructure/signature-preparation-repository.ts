import type { Prisma } from "@prisma/client";
import { DocumentRepository } from "./document-repository";

const intentInclude = { attempt: { include: { evidence: { orderBy: [{ observedAt: "asc" }, { id: "asc" }] } } } } satisfies Prisma.SignatureProviderIntentInclude;
export class SignaturePreparationRepository extends DocumentRepository {
  scope(scopeHash: string) { return this.tx.signatureProviderScope.findFirst({ where: { organizationId: this.organizationId, scopeHash } }); }
  async lockProviderScope(scopeHash: string) { await this.tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${'signature-provider-scope:' + scopeHash},0))::text`; }
  appendScope(data: Omit<Prisma.SignatureProviderScopeUncheckedCreateInput, "organizationId">) { return this.tx.signatureProviderScope.create({ data: { ...data, organizationId: this.organizationId } }); }
  preparation(id: string) { return this.tx.signatureProviderIntent.findFirst({ where: { organizationId: this.organizationId, id }, include: intentInclude }); }
  preparationByNonce(requestedBy: string, commandKey: string) { return this.tx.signatureProviderIntent.findFirst({ where: { organizationId: this.organizationId, requestedBy, commandKey }, include: intentInclude }); }
  preparationNonceOwner(commandKey: string) { return this.tx.signatureProviderIntent.findFirst({ where: { organizationId: this.organizationId, commandKey }, select: { requestedBy: true } }); }
  appendPreparation(data: Omit<Prisma.SignatureProviderIntentUncheckedCreateInput, "organizationId">) { return this.tx.signatureProviderIntent.create({ data: { ...data, organizationId: this.organizationId }, include: intentInclude }); }
  preparationAttempt(signatureId: string) { return this.tx.signatureProviderAttempt.findFirst({ where: { organizationId: this.organizationId, signatureId, phase: "PREPARE" }, include: { intent: true, evidence: { orderBy: [{ observedAt: "asc" }, { id: "asc" }] } } }); }
  appendPreparationAttempt(data: Omit<Prisma.SignatureProviderAttemptUncheckedCreateInput, "organizationId">) { return this.tx.signatureProviderAttempt.create({ data: { ...data, organizationId: this.organizationId } }); }
  preparationEvidence(attemptId: string, observationHash: string) { return this.tx.signatureProviderEvidence.findFirst({ where: { organizationId: this.organizationId, attemptId, observationHash } }); }
  appendPreparationEvidence(data: Omit<Prisma.SignatureProviderEvidenceUncheckedCreateInput, "organizationId">) { return this.tx.signatureProviderEvidence.create({ data: { ...data, organizationId: this.organizationId } }); }
}
