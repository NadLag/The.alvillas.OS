import {documentUploadInput} from "@/modules/documents/domain/document-command";
import {documentGenerationDraftSchema} from "@/modules/documents/domain/document-generation";

/** Canonical public input contracts shared by the native onboarding orchestrator. */
export const ownerPackageDocumentReasonSchema=documentUploadInput.shape.reason;
export const ownerPackageDocumentDraftSchema=documentGenerationDraftSchema;
