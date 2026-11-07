import { z } from "zod";
import { documentUploadInput } from "./document-command";
import { signedArchiveAssetKinds } from "./document-signed-archive";

/** Internal native generation protocol. Public file admission remains FILE/TEMPLATE only. */
export const generatedDocumentUploadInput = z.object({ ...documentUploadInput.shape,
  documentId: z.uuid(), kind: z.literal("INSTANCE"), contentType: z.literal("application/pdf"),
  templateKey: z.null(), supersedesId: z.uuid().nullable(), parts: z.never().optional(), generationInstanceId: z.uuid()
}).strict();
/** Internal existing-provider artifacts never enter the public upload command. */
export const signedDocumentUploadInput = z.object({ ...documentUploadInput.shape, documentId: z.uuid(), kind: z.literal("FILE"), contentType: z.literal("application/pdf"), templateKey: z.null(), supersedesId: z.null(), effectiveFrom: z.null(), parts: z.never().optional(), signedArchiveId: z.uuid(), signedArtifactId: z.uuid(), signedArtifactKind: z.enum(signedArchiveAssetKinds) }).strict();
export const storedDocumentUploadInput = z.union([documentUploadInput, generatedDocumentUploadInput, signedDocumentUploadInput]);
