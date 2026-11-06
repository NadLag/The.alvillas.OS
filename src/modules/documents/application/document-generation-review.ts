import { captureAuthorizationCap } from "@/platform/authz/authorization-cap";
import { commandFingerprint } from "@/platform/http/command-fingerprint";
import type { TenantTransactionRunner } from "@/platform/db/tenant";
import { documentGenerationDraftSchema } from "../domain/document-generation";
import { documentTemplateVariantsSchema } from "../domain/document-template";
import { documentPdfInputSchema } from "../domain/document-pdf";
import { DocumentConfigurationError, DocumentConflictError } from "../domain/document-command";
import { documentActorContext, readDocumentTemplateDefinition, type DocumentActorContext } from "./document-archive";
import { resolveDocumentTemplateValues } from "./document-template-values";

/** Server-only preparation. No caller values, locale fallback or PDF/storage writes. */
export async function prepareDocumentGeneration(actor: DocumentActorContext, raw: unknown, deps: { db: TenantTransactionRunner; env?: NodeJS.ProcessEnv; requestId?: string }) {
  const ctx = documentActorContext(actor), draft = documentGenerationDraftSchema.parse(raw), ids = [...draft.variantVersionIds].sort();
  const variants = await Promise.all(ids.map(versionId => readDocumentTemplateDefinition(ctx, { versionId }, deps)));
  documentTemplateVariantsSchema.parse(variants.map(variant => variant.definition));
  const selected = variants.find(variant => variant.versionId === draft.templateVersionId);
  if (!selected || variants.some(variant => variant.typeKey !== selected.typeKey || variant.templateKey !== selected.templateKey)) throw new DocumentConflictError();
  const values = await resolveDocumentTemplateValues(ctx, draft.source, selected.definition, selected.typeKey, deps), type = values.policySnapshot.value.types.find(type => type.key === selected.typeKey);
  if (!type || !values.policySnapshot.value.upload_transport) throw new DocumentConfigurationError();
  const contractFingerprint = commandFingerprint([...selected.definition.variables].sort((left, right) => left.key.localeCompare(right.key))),
    renderInput = documentPdfInputSchema.parse({ source: values.rendered, provenance: { templateVersionId: selected.versionId, templateSha256: selected.sha256, sourceFingerprint: values.sourceFingerprint }, maximumBytes: type.max_bytes }),
    originalVariants = variants.map(variant => ({ versionId: variant.versionId, sha256: variant.sha256, locale: variant.locale }));
  const reviewFingerprint = commandFingerprint({ actorId: ctx.actorId, command: { ...draft, variantVersionIds: ids }, templates: variants.map(original => ({ versionId: original.versionId, documentId: original.documentId,
    sha256: original.sha256, typeKey: original.typeKey, templateKey: original.templateKey, locale: original.locale, rootRevision: original.rootRevision, sourceFingerprint: original.sourceFingerprint, policyFingerprint: original.policyFingerprint })),
    contractFingerprint, sourceFingerprint: values.sourceFingerprint, nativeSourceFingerprint: values.nativeSourceFingerprint, policy: values.policySnapshot, cap: captureAuthorizationCap(ctx.authContext) });
  return { draft: { ...draft, variantVersionIds: ids }, selected, variants: originalVariants, renderInput, contractFingerprint, sourceFingerprint: values.sourceFingerprint,
    nativeSourceFingerprint: values.nativeSourceFingerprint, policySnapshot: values.policySnapshot, reviewFingerprint };
}

export async function reviewDocumentGeneration(actor: DocumentActorContext, raw: unknown, deps: Parameters<typeof prepareDocumentGeneration>[2]) {
  const prepared = await prepareDocumentGeneration(actor, raw, deps);
  return { reviewFingerprint: prepared.reviewFingerprint, templateVersionId: prepared.selected.versionId, locale: prepared.selected.locale, typeKey: prepared.selected.typeKey,
    source: prepared.draft.source, privacy: prepared.renderInput.source.privacy, variants: prepared.variants, contractFingerprint: prepared.contractFingerprint };
}
