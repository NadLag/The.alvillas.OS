import { z } from "zod";
import { signatureRecipientReferenceSchema } from "./document-signature-command";

export const nativeSignatureHistoryStates = z.enum(["DRAFT", "SENT", "VIEWED", "SIGNED", "DECLINED", "EXPIRED"]);
const cursor = z.string().max(6000).optional();
export const nativeSignatureListInput = z.object({ documentVersionId: z.uuid(), cursor }).strict();
export const nativeSignatureHistoryInput = z.object({ signatureId: z.uuid(), cursor }).strict();
const summary = z.object({ id: z.uuid(), documentId: z.uuid(), instanceId: z.uuid(), documentVersionId: z.uuid(), requestedAt: z.iso.datetime(), state: nativeSignatureHistoryStates }).strict();
export const nativeSignatureListSchema = z.object({ documentVersionId: z.uuid(), items: z.array(summary).max(30), next: z.string().nullable() }).strict();
export const nativeSignatureHistorySchema = z.object({ signature: summary, document: z.object({ title: z.string(), locale: z.enum(["en", "fr", "ar"]), sha256: z.string().regex(/^[a-f0-9]{64}$/u) }).strict(), preparation: z.object({ id: z.uuid(), state: z.enum(["PREPARED", "UNCERTAIN"]) }).strict().nullable(),
  recipients: z.array(z.object({ id: z.uuid(), reference: signatureRecipientReferenceSchema, displayName: z.string(), email: z.email() }).strict()).min(1).max(100),
  events: z.array(z.object({ id: z.uuid(), state: nativeSignatureHistoryStates, occurredAt: z.iso.datetime(), observedAt: z.iso.datetime(), signedVersionId: z.uuid().nullable() }).strict()).max(50), next: z.string().nullable()
}).strict();
