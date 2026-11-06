import { z } from "zod";
import { documentContentTypes } from "./document-policy";

export const documentObjectIdentitySchema = z.object({ organizationId: z.uuid(), documentId: z.uuid(), admissionId: z.uuid(),
  contentType: z.enum(documentContentTypes), fileSize: z.number().int().min(1).max(10 * 1024 * 1024), sha256: z.string().regex(/^[a-f0-9]{64}$/u) }).strict();
export type DocumentObjectIdentity = z.infer<typeof documentObjectIdentitySchema>;
export const documentCipherIdentitySchema = z.object({ cipherSize: z.number().int().positive(), cipherSha256: z.string().regex(/^[a-f0-9]{64}$/u), keyVersion: z.string().min(1).max(180) });
export type DocumentCipherIdentity = z.infer<typeof documentCipherIdentitySchema>;

export function documentObjectKey(identity: DocumentObjectIdentity): string {
  const value = documentObjectIdentitySchema.parse(identity);
  return `organizations/${value.organizationId}/documents/${value.documentId}/admissions/${value.admissionId}.encrypted`;
}

/** Authenticate every native identity as well as the exact original plaintext. */
export function documentEncryptionContext(identity: DocumentObjectIdentity): string {
  const value = documentObjectIdentitySchema.parse(identity);
  return JSON.stringify(["document-archive-v1", value.organizationId, value.documentId, value.admissionId, value.contentType, value.fileSize, value.sha256]);
}
