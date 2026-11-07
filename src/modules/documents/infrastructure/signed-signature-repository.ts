import type { Prisma } from "@prisma/client";
import { SignatureWebhookRepository } from "./signature-webhook-repository";

const artifactInclude = { admission: { include: { version: true } }, document: true } satisfies Prisma.SignatureSignedArtifactInclude;
const archiveInclude = { artifacts: { include: artifactInclude, orderBy: { kind: "asc" } }, evidence: { orderBy: [{ observedAt: "asc" }, { id: "asc" }] } } satisfies Prisma.SignatureSignedArchiveInclude;
export class SignedSignatureRepository extends SignatureWebhookRepository {
  signedArtifactForDocument(documentId: string) { return this.tx.signatureSignedArtifact.findFirst({ where: { organizationId: this.organizationId, documentId }, include: { ...artifactInclude, archive: { include: archiveInclude } } }); }
  signedArchive(id: string) { return this.tx.signatureSignedArchive.findFirst({ where: { organizationId: this.organizationId, id }, include: archiveInclude }); }
  signedArchiveForSignature(signatureId: string) { return this.tx.signatureSignedArchive.findFirst({ where: { organizationId: this.organizationId, signatureId }, include: archiveInclude }); }
  appendSignedArchive(data: Omit<Prisma.SignatureSignedArchiveUncheckedCreateInput, "organizationId">) { return this.tx.signatureSignedArchive.create({ data: { ...data, organizationId: this.organizationId }, include: archiveInclude }); }
  appendSignedArtifact(data: Omit<Prisma.SignatureSignedArtifactUncheckedCreateInput, "organizationId">) { return this.tx.signatureSignedArtifact.create({ data: { ...data, organizationId: this.organizationId }, include: artifactInclude }); }
  completionEvidence(signatureId: string) { return this.tx.signatureProviderEvidence.findFirst({ where: { organizationId: this.organizationId, signatureId, kind: "COMPLETION", phase: "PREPARE" }, orderBy: [{ observedAt: "asc" }, { id: "asc" }] }); }
  signedReconciliationByNonce(actorId: string, commandKey: string) { return this.tx.documentAction.findFirst({ where: { organizationId: this.organizationId, actorId, commandKey, action: "SIGNED_ARCHIVE_RECONCILED" } }); }
  signedReconciliationNonceOwner(commandKey: string) { return this.tx.documentAction.findFirst({ where: { organizationId: this.organizationId, commandKey, action: "SIGNED_ARCHIVE_RECONCILED" }, select: { actorId: true } }); }
  signedReconciliation(id: string) { return this.tx.documentAction.findFirst({ where: { organizationId: this.organizationId, id, action: "SIGNED_ARCHIVE_RECONCILED" } }); }
}
