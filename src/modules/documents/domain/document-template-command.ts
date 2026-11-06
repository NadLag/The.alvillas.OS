import { z } from "zod";
import { documentUploadReviewInput,documentUploadInput } from "./document-command";
import { documentTemplateDefinitionSchema } from "./document-template";
const fields=documentUploadReviewInput.shape;
export const documentTemplateDraftSchema=z.object({documentId:fields.documentId,source:fields.source,typeKey:fields.typeKey,title:fields.title,
  supersedesId:fields.supersedesId,effectiveFrom:fields.effectiveFrom,definition:documentTemplateDefinitionSchema}).strict();
export const documentTemplateAdmissionSchema=documentTemplateDraftSchema.extend({idempotencyKey:documentUploadInput.shape.idempotencyKey,
  reviewFingerprint:documentUploadInput.shape.reviewFingerprint,reason:documentUploadInput.shape.reason});
