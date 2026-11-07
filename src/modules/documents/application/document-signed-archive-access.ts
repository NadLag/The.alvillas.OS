import type { TenantTransaction } from "@/platform/db/tenant";
import { commandFingerprint } from "@/platform/http/command-fingerprint";
import { DocumentAccessError, DocumentConflictError } from "../domain/document-command";
import { signedArchiveProtocol } from "../domain/document-signed-archive";
import { SignedSignatureRepository } from "../infrastructure/signed-signature-repository";
import type { DocumentRepository } from "../infrastructure/document-repository";
import type { DocumentActorContext } from "./document-archive";
import { retainedNativeSignatureReadContext } from "./document-signature-history";
import { originalSignaturePreparation } from "./document-signature-preparation";
import { readNativeSignatureProviderEvidence } from "./document-signature-provider-evidence";
import { originalSignedArchive } from "./document-signed-archive-admission";

type Root = NonNullable<Awaited<ReturnType<DocumentRepository["document"]>>>;
/** Signed artifacts inherit every original source, template, signature and recipient check. */
export async function signedArchiveAccess(ctx: DocumentActorContext, tx: TenantTransaction, root: Root, action: "view" | "create" | "export", env?: NodeJS.ProcessEnv) {
  const repository = new SignedSignatureRepository(tx, ctx.organizationId), artifact = await repository.signedArtifactForDocument(root.id), marker = root.sourceSnapshot;
  if (!artifact) {
    if (marker && typeof marker === "object" && !Array.isArray(marker) && marker.protocol === signedArchiveProtocol) throw new DocumentAccessError();
    return null;
  }
  if (action === "create") throw new DocumentAccessError();
  const archive = artifact.archive, snapshot = originalSignedArchive(archive), signed = archive.evidence.find(row => row.kind === "SIGNED"), capture = archive.evidence.find(row => row.kind === "ARCHIVE_CAPTURED"), current = await retainedNativeSignatureReadContext(ctx, tx, archive.signatureId, { env });
  if (!signed || !capture || archive.artifacts.length !== 2 || archive.artifacts.some(row => !row.admission.version) || current.row.commandHash !== snapshot.signatureCommandHash || current.row.documentVersionId !== snapshot.document.versionId) throw new DocumentAccessError();
  const intent = await repository.preparation(snapshot.preparation.intentId); if (!intent) throw new DocumentConflictError();
  const original = originalSignaturePreparation(intent), value = readNativeSignatureProviderEvidence(intent, signed, original.snapshot, env), captured = readNativeSignatureProviderEvidence(intent, capture, original.snapshot, env), proof = value.signedArchive;
  if (value.kind !== "SIGNED" || captured.kind !== "ARCHIVE_CAPTURED" || !proof || proof.id !== archive.id || proof.captureEvidenceId !== capture.id || proof.completionEvidenceId !== archive.completionEvidenceId || proof.signedAssetId !== captured.signedArchive?.signedAssetId || proof.certificateAssetId !== captured.signedArchive.certificateAssetId || proof.signedSha256 !== captured.signedArchive.signedSha256 || proof.certificateSha256 !== captured.signedArchive.certificateSha256 || !archive.artifacts.some(row => row.id === proof.signedAssetId && row.kind === "SIGNED_ORIGINAL" && row.admission.version?.id === proof.signedVersionId && row.admission.sha256 === proof.signedSha256) || !archive.artifacts.some(row => row.id === proof.certificateAssetId && row.kind === "CERTIFICATE" && row.admission.version?.id === proof.certificateVersionId && row.admission.sha256 === proof.certificateSha256)) throw new DocumentConflictError();
  return { artifact: { kind: artifact.kind as "SIGNED_ORIGINAL" | "CERTIFICATE", signatureId: archive.signatureId, originalDocumentId: snapshot.document.id, originalVersionId: snapshot.document.versionId, originalVersionNumber: current.current.version.number }, privacy: snapshot.privacy, checks: [...current.current.checks, ...current.current.archive.checks], fingerprint: commandFingerprint({ signature: current.fingerprint, archive: archive.commandHash, capture: capture.payloadSha256, signed: signed.payloadSha256 }) };
}
