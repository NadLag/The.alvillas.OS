import { z } from "zod";

// Technical framing limits; the effective Operations policy controls image size.
export const fieldUploadChunkBytes = 256 * 1024;
export const fieldUploadMaximumParts = 64;
// Signature validity and transport bounds, not business retention settings.
export const privateUploadUrlLifetimeSeconds = 900;
export const privateUploadTransportTimeoutMs = 15000;
export const temporaryPartLeaseMilliseconds = privateUploadUrlLifetimeSeconds * 1000 + privateUploadTransportTimeoutMs + 1000;
export type TemporaryUploadPart = { organizationId: string; uploadId: string; index: number };

export function temporaryUploadPartKey({ organizationId, uploadId, index }: TemporaryUploadPart): string {
  z.uuid().parse(organizationId); z.uuid().parse(uploadId);
  z.number().int().min(0).max(fieldUploadMaximumParts - 1).parse(index);
  return `${organizationId}/uploads/${uploadId}/part-${index}`;
}

export function permanentFieldUploadKey(organizationId: string, taskId: string, uploadId: string): string {
  z.uuid().parse(organizationId); z.uuid().parse(taskId); z.uuid().parse(uploadId);
  return `${organizationId}/tasks/${taskId}/uploads/${uploadId}`;
}
