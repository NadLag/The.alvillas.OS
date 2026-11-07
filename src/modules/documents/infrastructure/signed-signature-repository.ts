import type { Prisma, SignatureProviderEvidence, DocumentAction, SignatureSignedArchive, SignatureSignedArtifact, DocumentAdmission, DocumentVersion, Document } from "@prisma/client";
import { SignatureWebhookRepository } from "./signature-webhook-repository";

const artifactInclude = { admission: { include: { version: true } }, document: true } satisfies Prisma.SignatureSignedArtifactInclude;
const archiveInclude = { artifacts: { include: artifactInclude, orderBy: { kind: "asc" } }, evidence: { orderBy: [{ observedAt: "asc" }, { id: "asc" }] } } satisfies Prisma.SignatureSignedArchiveInclude;
type SignedArtifact = SignatureSignedArtifact & { admission: DocumentAdmission & { version: DocumentVersion | null }; document: Document };
type SignedArchive = SignatureSignedArchive & { artifacts: SignedArtifact[]; evidence: SignatureProviderEvidence[] };
type SourceArtifact = SignedArtifact & { archive: SignedArchive };
export class SignedSignatureRepository extends SignatureWebhookRepository {
  async signedArtifactForDocument(documentId: string): Promise<SourceArtifact | null> { return this.tx.signatureSignedArtifact.findFirst({ where: { organizationId: this.organizationId, documentId }, include: { ...artifactInclude, archive: { include: archiveInclude } } }); }
  async signedArchive(id: string): Promise<SignedArchive | null> { return this.tx.signatureSignedArchive.findFirst({ where: { organizationId: this.organizationId, id }, include: archiveInclude }); }
  async signedArchiveForSignature(signatureId: string): Promise<SignedArchive | null> { return this.tx.signatureSignedArchive.findFirst({ where: { organizationId: this.organizationId, signatureId }, include: archiveInclude }); }
  async appendSignedArchive(data: Omit<Prisma.SignatureSignedArchiveUncheckedCreateInput, "organizationId">): Promise<SignedArchive> { return this.tx.signatureSignedArchive.create({ data: { ...data, organizationId: this.organizationId }, include: archiveInclude }); }
  async appendSignedArtifact(data: Omit<Prisma.SignatureSignedArtifactUncheckedCreateInput, "organizationId">): Promise<SignedArtifact> { return this.tx.signatureSignedArtifact.create({ data: { ...data, organizationId: this.organizationId }, include: artifactInclude }); }
  async completionEvidence(signatureId: string): Promise<SignatureProviderEvidence | null> { return this.tx.signatureProviderEvidence.findFirst({ where: { organizationId: this.organizationId, signatureId, kind: "COMPLETION", phase: "PREPARE" }, orderBy: [{ observedAt: "asc" }, { id: "asc" }] }); }
  async signedReconciliationByNonce(actorId: string, commandKey: string): Promise<DocumentAction | null> { return this.tx.documentAction.findFirst({ where: { organizationId: this.organizationId, actorId, commandKey, action: "SIGNED_ARCHIVE_RECONCILED" } }); }
  async signedReconciliationNonceOwner(commandKey: string): Promise<Pick<DocumentAction, "actorId"> | null> { return this.tx.documentAction.findFirst({ where: { organizationId: this.organizationId, commandKey, action: "SIGNED_ARCHIVE_RECONCILED" }, select: { actorId: true } }); }
  async signedReconciliation(id: string): Promise<DocumentAction | null> { return this.tx.documentAction.findFirst({ where: { organizationId: this.organizationId, id, action: "SIGNED_ARCHIVE_RECONCILED" } }); }
}
