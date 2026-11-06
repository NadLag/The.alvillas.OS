import { z } from "zod";
import { documentUploadInput } from "./document-command";

/** Internal native generation protocol. Public file admission remains FILE/TEMPLATE only. */
export const generatedDocumentUploadInput = z.object({ ...documentUploadInput.shape,
  documentId: z.uuid(), kind: z.literal("INSTANCE"), contentType: z.literal("application/pdf"),
  templateKey: z.null(), supersedesId: z.uuid().nullable(), parts: z.never().optional(), generationInstanceId: z.uuid()
}).strict();
export const storedDocumentUploadInput = z.union([documentUploadInput, generatedDocumentUploadInput]);
