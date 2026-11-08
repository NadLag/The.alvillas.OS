import { captureAuthorizationCap } from "@/platform/authz/authorization-cap";
import { commandFingerprint } from "@/platform/http/command-fingerprint";
import {withTenant,type TenantTransaction,type TenantTransactionRunner } from "@/platform/db/tenant";
import { documentGenerationDraftSchema,documentGenerationSnapshotSchema } from "../domain/document-generation";
import { documentTemplateVariantsSchema } from "../domain/document-template";
import { documentPdfInputSchema } from "../domain/document-pdf";
import { DocumentAccessError,DocumentConfigurationError, DocumentConflictError,documentSourceReferenceSchema } from "../domain/document-command";
import { documentActorContext,documentArchiveContext, readDocumentTemplateDefinition, type DocumentActorContext } from "./document-archive";
import { resolveDocumentTemplateValues } from "./document-template-values";
import {DocumentRepository} from "../infrastructure/document-repository";
import {generatedDocumentUploadInput} from "../domain/document-generated-upload";
import type {z} from "zod";

/** An amendment retains the actual logical source, language and native template family. */
export async function documentGenerationTarget(ctx:DocumentActorContext,tx:TenantTransaction,draft:z.infer<typeof documentGenerationDraftSchema>,selected:Pick<Awaited<ReturnType<typeof readDocumentTemplateDefinition>>,"typeKey"|"locale"|"templateKey">,privacy:readonly string[],env?:NodeJS.ProcessEnv){
  const repository=new DocumentRepository(tx,ctx.organizationId);let root=draft.documentId?await repository.document(draft.documentId):null;
  if(draft.documentId&&!root)throw new DocumentAccessError();
  if(root){
    await documentArchiveContext(ctx,tx,documentSourceReferenceSchema.parse({kind:root.sourceKind,id:root.sourceId}),"view",root,undefined,env);
    if(root.kind!=="INSTANCE"||root.sourceKind!==draft.source.kind||root.sourceId!==draft.source.id||root.typeKey!==selected.typeKey||root.locale!==selected.locale)throw new DocumentConflictError();
    const previous=await repository.latest(root.id);if(!previous||previous.id!==draft.supersedesId)throw new DocumentConflictError();
    const original=generatedDocumentUploadInput.parse(previous.admission.input),prior=await repository.instance(original.generationInstanceId);if(!prior||prior.documentId!==root.id)throw new DocumentConflictError();
    // Pending siblings cannot change the actual archived predecessor used by this review.
    root=prior.document;
    documentGenerationSnapshotSchema.parse(prior.sourceSnapshot);const templateVersion=await repository.version(prior.templateVersionId),template=templateVersion?await repository.document(templateVersion.documentId):null;
    if(!template?.template||template.template.key!==selected.templateKey||template.locale!==selected.locale||template.typeKey!==selected.typeKey)throw new DocumentConflictError();
    const current=await documentArchiveContext(ctx,tx,draft.source,"create",root,{kind:"INSTANCE",typeKey:selected.typeKey,privacy,newInstance:true},env);return{root,previous,current};
  }
  return{root:null,previous:null,current:await documentArchiveContext(ctx,tx,draft.source,"create",undefined,{kind:"INSTANCE",typeKey:selected.typeKey,privacy,newInstance:true},env)};
}

/** Server-only preparation. No caller values, locale fallback or PDF/storage writes. */
export async function prepareDocumentGeneration(actor: DocumentActorContext, raw: unknown, deps: { db: TenantTransactionRunner; env?: NodeJS.ProcessEnv; requestId?: string }) {
  const ctx = documentActorContext(actor), draft = documentGenerationDraftSchema.parse(raw), ids = [...draft.variantVersionIds].sort();
  const variants = await Promise.all(ids.map(versionId => readDocumentTemplateDefinition(ctx, { versionId }, deps)));
  documentTemplateVariantsSchema.parse(variants.map(variant => variant.definition));
  const selected = variants.find(variant => variant.versionId === draft.templateVersionId);
  if (!selected || variants.some(variant => variant.typeKey !== selected.typeKey || variant.templateKey !== selected.templateKey)) throw new DocumentConflictError();
  const values = await resolveDocumentTemplateValues(ctx, draft.source, selected.definition, selected.typeKey, { ...deps, additionalPrivacy: variants.flatMap(variant => variant.privacy) }), type = values.policySnapshot.value.types.find(type => type.key === selected.typeKey);
  if (!type || !values.policySnapshot.value.upload_transport) throw new DocumentConfigurationError();
  const target=await withTenant(deps.db,ctx.organizationId,async tx=>draft.documentId?documentGenerationTarget(ctx,tx,draft,selected,values.rendered.privacy,deps.env):{
    root:null,previous:null,current:await documentArchiveContext(ctx,tx,draft.source,"export",undefined,{kind:"INSTANCE",typeKey:selected.typeKey,privacy:values.rendered.privacy},deps.env)});
  if(target.current.native.fingerprint!==values.nativeSourceFingerprint||commandFingerprint(target.current.policy)!==commandFingerprint(values.policySnapshot))throw new DocumentConflictError();
  const contractFingerprint = commandFingerprint([...selected.definition.variables].sort((left, right) => left.key.localeCompare(right.key))),
    renderInput = documentPdfInputSchema.parse({ source: values.rendered, provenance: { templateVersionId: selected.versionId, templateSha256: selected.sha256, sourceFingerprint: values.sourceFingerprint }, maximumBytes: type.max_bytes }),
    originalVariants = variants.map(variant => ({ versionId: variant.versionId, documentId: variant.documentId, fingerprint: variant.fingerprint, sha256: variant.sha256, locale: variant.locale }));
  const reviewFingerprint = commandFingerprint({ actorId: ctx.actorId, command: { ...draft, variantVersionIds: ids }, templates: variants.map(original => ({ versionId: original.versionId, documentId: original.documentId,
    sha256: original.sha256, typeKey: original.typeKey, templateKey: original.templateKey, locale: original.locale, rootRevision: original.rootRevision, sourceFingerprint: original.sourceFingerprint, policyFingerprint: original.policyFingerprint, privacy: original.privacy, fingerprint: original.fingerprint })),
    contractFingerprint, sourceFingerprint: values.sourceFingerprint, nativeSourceFingerprint: values.nativeSourceFingerprint, policy: values.policySnapshot, cap: captureAuthorizationCap(ctx.authContext),...target.root?{document:{id:target.root.id,revision:target.root.revision.toString(),previous:target.previous?.id,fingerprint:target.current.fingerprint}}:{} });
  return { draft: { ...draft, variantVersionIds: ids }, selected, variants: originalVariants, renderInput, contractFingerprint, sourceFingerprint: values.sourceFingerprint,
    nativeSourceFingerprint: values.nativeSourceFingerprint, policySnapshot: values.policySnapshot, reviewFingerprint,targetFingerprint:target.current.fingerprint };
}

export async function reviewDocumentGeneration(actor: DocumentActorContext, raw: unknown, deps: Parameters<typeof prepareDocumentGeneration>[2]) {
  const prepared = await prepareDocumentGeneration(actor, raw, deps);
  return { reviewFingerprint: prepared.reviewFingerprint, templateVersionId: prepared.selected.versionId, locale: prepared.selected.locale, typeKey: prepared.selected.typeKey,
    source: prepared.draft.source, privacy: prepared.renderInput.source.privacy, variants: prepared.variants, contractFingerprint: prepared.contractFingerprint };
}
