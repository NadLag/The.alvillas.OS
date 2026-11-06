import { createHash } from "node:crypto";
import { documentUploadReviewInput } from "../domain/document-command";
import { encodeDocumentTemplate } from "../domain/document-template";
import { documentTemplateDraftSchema,documentTemplateAdmissionSchema } from "../domain/document-template-command";
import { documentTemplateMediaType,documentTemplateFileName } from "../domain/document-template-format";
import { reviewDocumentUpload, admitDocumentUpload, type DocumentActorContext } from "./document-archive";

export {documentTemplateDraftSchema,documentTemplateAdmissionSchema} from "../domain/document-template-command";
type Dependencies=Parameters<typeof admitDocumentUpload>[2];

export function prepareDocumentTemplate(raw:unknown){
  const input=documentTemplateDraftSchema.parse(raw),definition=input.definition,bytes=encodeDocumentTemplate(definition);
  const metadata=documentUploadReviewInput.parse({documentId:input.documentId,source:input.source,typeKey:input.typeKey,title:input.title,kind:"TEMPLATE",
    locale:definition.locale,templateKey:definition.templateKey,fileName:documentTemplateFileName(definition.templateKey,definition.locale),contentType:documentTemplateMediaType,
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
