import { prisma } from "@/platform/db/client";
import { withTenant, type TenantTransactionRunner } from "@/platform/db/tenant";
import { R2StorageProvider } from "@/platform/providers/real";
import { temporaryPartLeaseMilliseconds, type TemporaryUploadPart } from "@/platform/storage/upload-protocol";
import { fieldUploadManifestSchema } from "../domain/field-upload";
import { FieldUploadRepository } from "../infrastructure/field-upload-repository";

type CleanupDeps = { db?: TenantTransactionRunner; now?: Date; limit?: number; clock?: () => number;
  storage?: { deleteTemporaryUploadPart(input: TemporaryUploadPart): Promise<void> } };

/** Infrastructure cleanup of redundant transport parts; no permanent evidence is deleted. */
export async function cleanupFieldUploadParts(organizationId: string, deps: CleanupDeps = {}) {
  const now = deps.now ?? new Date(), db = deps.db ?? prisma, limit = deps.limit ?? 25;
  const clock = deps.clock ?? (() => performance.now()), started = clock();
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw Error("Invalid upload cleanup batch size");
  const candidates = await withTenant(db, organizationId, tx => new FieldUploadRepository(tx, organizationId)
    .cleanupCandidates(now, new Date(now.getTime() - temporaryPartLeaseMilliseconds), limit));
  if (!candidates.length) return { cleaned: 0 };
  const storage = deps.storage ?? new R2StorageProvider(); let cleaned = 0, failed = false;
  for (const upload of candidates) {
    if (clock() - started >= 30000) break;
    try {
      const manifest = fieldUploadManifestSchema.parse(upload.manifest);
      // The status is already closed to PUT signatures. Every outstanding signed
      // PUT and its bounded request must expire before deletion can start.
      for (let offset = 0; offset < manifest.parts.length; offset += 4) {
        if (clock() - started >= 30000) {
          if (failed) throw Error("Temporary upload cleanup unavailable");
          return { cleaned };
        }
        await Promise.all(manifest.parts.slice(offset, offset + 4)
          .map((_, index) => storage.deleteTemporaryUploadPart({ organizationId, uploadId: upload.id, index: offset + index })));
      }
      const result = await withTenant(db, organizationId, async tx => {
        const repository = new FieldUploadRepository(tx, organizationId);
        await repository.lock(`${upload.actorId}:${upload.localId}`);
        return repository.cleaned(upload.id, now);
      });
      cleaned += result.count;
    } catch {
      failed = true;
      // Rotate failed rows behind older pending work instead of starving the
      // next bounded batch. This changes infrastructure retry metadata only.
      await withTenant(db, organizationId, tx => new FieldUploadRepository(tx, organizationId).cleanupAttempted(upload.id, now))
        .catch(() => undefined);
    }
  }
  // Inngest retries this step; the next dispatcher tick also recovers unmarked
  // rows. Missing parts and duplicate cleanup are safe, including lost DELETE ACKs.
  if (failed) throw Error("Temporary upload cleanup unavailable");
  return { cleaned };
}
