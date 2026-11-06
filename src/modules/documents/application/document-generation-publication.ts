import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { withTenant, type TenantTransactionRunner } from "@/platform/db/tenant";
import type { PdfRenderer } from "@/platform/providers";
import { restoreAuthorizationCap } from "@/platform/authz/authorization-cap";
import { DocumentRepository } from "../infrastructure/document-repository";
import type { DocumentObjectStore } from "../infrastructure/document-object-store";
import { openDocumentGenerationInput } from "../infrastructure/document-generation-payload";
import { sealGeneratedDocumentPayload } from "../infrastructure/document-generated-payload";
import { configuredDocumentPdfRenderer } from "../infrastructure/document-pdf-renderer";
import { generatedDocumentUploadInput } from "../domain/document-generated-upload";
import { documentGenerationSnapshotSchema } from "../domain/document-generation";
import { documentPdfTemplate, validateGeneratedPdf, DocumentPdfConfigurationError } from "../domain/document-pdf";
import { DocumentAccessError, DocumentConflictError } from "../domain/document-command";
import { documentActorContext, documentArchiveContext, appendDocumentHistory, documentJson, completeDocumentParts, type DocumentActorContext } from "./document-archive";
import { documentGenerationResult } from "./document-generation-admission";

const reference = z.object({ instanceId: z.uuid() }).strict();
type Dependencies = { db: TenantTransactionRunner; env?: NodeJS.ProcessEnv; objects: DocumentObjectStore; pdf?: PdfRenderer; requestId?: string };

/** Provider and storage I/O take place outside database transactions. Recovery always uses the first admitted bytes. */
export async function publishDocumentGeneration(actor: DocumentActorContext, raw: unknown, deps: Dependencies) {
  const ctx = documentActorContext(actor), input = reference.parse(raw);
  const captured = await withTenant(deps.db, ctx.organizationId, async tx => {
    const repository = new DocumentRepository(tx, ctx.organizationId), row = await repository.instance(input.instanceId); if (!row) throw new DocumentAccessError();
    const receipt = await documentGenerationResult(ctx, tx, row); if (receipt.state === "SOURCE_CHANGED") throw new DocumentConflictError();
    const snapshot = documentGenerationSnapshotSchema.parse(row.sourceSnapshot), admission = await repository.byNonce(ctx.actorId, row.commandKey);
    if (admission && (admission.documentId !== row.documentId || admission.commandHash !== row.commandHash || generatedDocumentUploadInput.parse(admission.input).generationInstanceId !== row.id)) throw new DocumentConflictError();
    return { receipt, snapshot, admissionId: admission?.id ?? null, original: receipt.state === "COMPLETE" || admission ? null : openDocumentGenerationInput(snapshot.identity, Buffer.from(snapshot.payloadCipher, "base64"), deps.env) };
  });
  if (captured.receipt.state === "COMPLETE") return captured.receipt;
  let admissionId = captured.admissionId;
  if (!admissionId) {
    if (!captured.original) throw new DocumentConflictError();
    let bytes: Uint8Array;
    try { bytes = validateGeneratedPdf(await (deps.pdf ?? configuredDocumentPdfRenderer(deps.env)).render({ template: documentPdfTemplate, locale: captured.original.source.locale, data: structuredClone(captured.original) }), captured.original.maximumBytes); }
    catch { throw new DocumentPdfConfigurationError(); }
    admissionId = await withTenant(deps.db, ctx.organizationId, async tx => {
      const repository = new DocumentRepository(tx, ctx.organizationId); await repository.lock("nonce:" + ctx.actorId + ":" + captured.snapshot.command.idempotencyKey);
      await repository.lock("root:"+captured.snapshot.identity.documentId);
      const row = await repository.instance(input.instanceId); if (!row) throw new DocumentAccessError();
      const receipt = await documentGenerationResult(ctx, tx, row); if (receipt.state === "SOURCE_CHANGED") throw new DocumentConflictError();
      const existing = await repository.byNonce(ctx.actorId, row.commandKey);
      if (existing) {
        if (existing.documentId !== row.documentId || existing.commandHash !== row.commandHash || generatedDocumentUploadInput.parse(existing.input).generationInstanceId !== row.id) throw new DocumentConflictError();
        return existing.id;
      }
      if (receipt.state !== "PENDING") throw new DocumentConflictError();
      const snapshot = documentGenerationSnapshotSchema.parse(row.sourceSnapshot), root = row.document, current = await documentArchiveContext(ctx, tx, snapshot.command.source, "create", root),
        originalActor = documentActorContext({ ...ctx, authContext: restoreAuthorizationCap(snapshot.authorizationCap) }), held = await documentArchiveContext(originalActor, tx, snapshot.command.source, "create", root);
      if (current.fingerprint !== held.fingerprint || !current.policy.value.upload_transport) throw new DocumentConflictError();
      const id = randomUUID(), sha256 = createHash("sha256").update(bytes).digest("hex"), metadata = generatedDocumentUploadInput.parse({ documentId: root.id, source: snapshot.command.source, typeKey: root.typeKey, kind: "INSTANCE", locale: root.locale,
        title: snapshot.command.title, effectiveFrom: snapshot.command.effectiveFrom, reason: snapshot.command.reason, reviewFingerprint: snapshot.command.reviewFingerprint, idempotencyKey: snapshot.command.idempotencyKey,
        templateKey: null, supersedesId: snapshot.command.supersedesId??null, fileName: "document-" + row.id + ".pdf", contentType: "application/pdf", fileSize: bytes.length, sha256, generationInstanceId: row.id });
      if (!current.type?.content_types.includes("application/pdf") || bytes.length > current.type.max_bytes) throw new DocumentConflictError();
      const identity = { organizationId: ctx.organizationId, documentId: root.id, admissionId: id, contentType: "application/pdf" as const, fileSize: bytes.length, sha256 };
      await repository.appendAdmission({ id, documentId: root.id, commandKey: row.commandKey, commandHash: row.commandHash, input: documentJson(metadata), fileName: metadata.fileName,
        contentType: metadata.contentType, fileSize: bytes.length, sha256, storageKey: "organizations/" + ctx.organizationId + "/documents/" + root.id + "/admissions/" + id + ".encrypted",
        expectedRevision: root.revision, supersedesId: metadata.supersedesId, sourceFingerprint: current.native.fingerprint, policySnapshot: documentJson(current.policy), authorizationCap: documentJson(snapshot.authorizationCap),
        reason: metadata.reason, payloadCipher: new Uint8Array(sealGeneratedDocumentPayload(identity, bytes, deps.env)), createdBy: ctx.actorId, createdAt: current.now });
      await appendDocumentHistory(ctx, tx, current, root.id, "ADMITTED", row.commandKey, row.commandHash, metadata.reason, {}, { admissionId: id }, deps);
      const final = await documentArchiveContext(ctx, tx, snapshot.command.source, "create", root), finalHeld = await documentArchiveContext(originalActor, tx, snapshot.command.source, "create", root);
      if (final.fingerprint !== current.fingerprint || finalHeld.fingerprint !== held.fingerprint) throw new DocumentConflictError(); return id;
    });
  }
  await completeDocumentParts(ctx, { admissionId }, deps);
  return withTenant(deps.db, ctx.organizationId, async tx => { const row = await new DocumentRepository(tx, ctx.organizationId).instance(input.instanceId); if (!row) throw new DocumentAccessError(); return documentGenerationResult(ctx, tx, row); });
}
