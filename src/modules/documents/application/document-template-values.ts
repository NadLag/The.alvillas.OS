import { withTenant, type TenantTransactionRunner } from "@/platform/db/tenant";
import { recheckAccountAuthorization } from "@/platform/authz/current-authority";
import { commandFingerprint } from "@/platform/http/command-fingerprint";
import { documentSourceReferenceSchema, documentUploadReviewInput, DocumentAccessError, DocumentConflictError } from "../domain/document-command";
import { retainDocumentPrivacy } from "../domain/document-policy";
import { documentTemplateDefinitionSchema, renderDocumentTemplate } from "../domain/document-template";
import { DocumentTemplateSourceRepository } from "../infrastructure/document-template-source-repository";
import { documentActorContext, documentAuthorityChecks, documentSourceContext, type DocumentActorContext } from "./document-archive";

/** Server-only generation boundary: native source fields, held/current authority and no caller values. */
export async function resolveDocumentTemplateValues(actor: DocumentActorContext, rawSource: unknown, rawDefinition: unknown, rawTypeKey: unknown, deps: { db: TenantTransactionRunner }) {
  const ctx = documentActorContext(actor);
  const source = documentSourceReferenceSchema.parse(rawSource), definition = documentTemplateDefinitionSchema.parse(rawDefinition), typeKey = documentUploadReviewInput.shape.typeKey.parse(rawTypeKey);
  return withTenant(deps.db, actor.organizationId, async tx => {
    const current = await documentSourceContext(ctx, tx, source, "export"), type = current.policy.value.types.find(item => item.key === typeKey);
    if (current.native.archived || !type?.sources.includes(source.kind) || !type.content_types.includes("application/pdf")) throw new DocumentAccessError();
    const repository = new DocumentTemplateSourceRepository(tx, actor.organizationId), keys = definition.variables.map(variable => variable.key), original = await repository.templateSourceValues(current.native, keys), rendered = renderDocumentTemplate(definition, original.bindings);
    rendered.privacy = retainDocumentPrivacy(rendered.privacy, type.privacy, source.kind);
    const checks = documentAuthorityChecks(current.native, rendered.privacy, "export", { kind: "INSTANCE", createdBy: actor.actorId });
    await recheckAccountAuthorization(ctx, tx, await repository.clock(), checks, new DocumentAccessError());
    const latest = await documentSourceContext(ctx, tx, source, "export"), rechecked = await repository.templateSourceValues(latest.native, keys);
    if (current.native.fingerprint !== latest.native.fingerprint || original.fingerprint !== rechecked.fingerprint || commandFingerprint(current.policy) !== commandFingerprint(latest.policy)) throw new DocumentConflictError();
    await recheckAccountAuthorization(ctx, tx, await repository.clock(), documentAuthorityChecks(latest.native, rendered.privacy, "export", { kind: "INSTANCE", createdBy: actor.actorId }), new DocumentAccessError());
    return { rendered, sourceFingerprint: original.fingerprint, sourceReference: source, nativeSourceFingerprint: latest.native.fingerprint, policySnapshot: current.policy };
  });
}
