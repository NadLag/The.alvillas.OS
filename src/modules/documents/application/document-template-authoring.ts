import { createHash } from "node:crypto";
import { z } from "zod";
import { documentUploadReviewInput, documentUploadInput } from "../domain/document-command";
import { documentTemplateDefinitionSchema, encodeDocumentTemplate } from "../domain/document-template";
import { documentTemplateMediaType } from "../domain/document-template-format";
import { reviewDocumentUpload, admitDocumentUpload, type DocumentActorContext } from "./document-archive";

const fields=documentUploadReviewInput.shape;
export const documentTemplateDraftSchema=z.object({documentId:fields.documentId,source:fields.source,typeKey:fields.typeKey,title:fields.title,
  supersedesId:fields.supersedesId,effectiveFrom:fields.effectiveFrom,definition:documentTemplateDefinitionSchema}).strict();
export const documentTemplateAdmissionSchema=documentTemplateDraftSchema.extend({idempotencyKey:documentUploadInput.shape.idempotencyKey,
  reviewFingerprint:documentUploadInput.shape.reviewFingerprint,reason:documentUploadInput.shape.reason});
type Dependencies=Parameters<typeof admitDocumentUpload>[2];

export function prepareDocumentTemplate(raw:unknown){
  const input=documentTemplateDraftSchema.parse(raw),definition=input.definition,bytes=encodeDocumentTemplate(definition);
  const metadata=documentUploadReviewInput.parse({documentId:input.documentId,source:input.source,typeKey:input.typeKey,title:input.title,kind:"TEMPLATE",
    locale:definition.locale,templateKey:definition.templateKey,fileName:definition.templateKey+"."+definition.locale+".template.json",contentType:documentTemplateMediaType,
    fileSize:bytes.length,sha256:createHash("sha256").update(bytes).digest("hex"),supersedesId:input.supersedesId,effectiveFrom:input.effectiveFrom});
  return{metadata,bytes};
}
export async function reviewDocumentTemplate(actor:DocumentActorContext,raw:unknown,deps:Dependencies){
  const prepared=prepareDocumentTemplate(raw);return{...await reviewDocumentUpload(actor,prepared.metadata,deps),metadata:prepared.metadata};
}
export async function admitDocumentTemplate(actor:DocumentActorContext,raw:unknown,deps:Dependencies){
  const parsed=documentTemplateAdmissionSchema.parse(raw),{idempotencyKey,reviewFingerprint,reason,...draft}=parsed,prepared=prepareDocumentTemplate(draft);
  return admitDocumentUpload(actor,{...prepared.metadata,idempotencyKey,reviewFingerprint,reason},{...deps,preparedTemplate:prepared.bytes});
}
