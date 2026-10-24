import { z } from "zod";

// Technical framing limits; the effective Operations policy controls image size.
export const fieldUploadChunkBytes = 256 * 1024;
export const fieldUploadMaximumParts = 64;
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
