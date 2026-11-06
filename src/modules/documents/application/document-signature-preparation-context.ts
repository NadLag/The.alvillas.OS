import type { z } from "zod";
import type { TenantTransaction } from "@/platform/db/tenant";
import { ConfigRuleRepository } from "@/platform/config/config-rule-repository";
import { commandFingerprint } from "@/platform/http/command-fingerprint";
import { captureAuthorizationCap } from "@/platform/authz/authorization-cap";
import { signatureRequestMetadataSchema } from "@/platform/providers/signature-contract";
import { documentSignaturePolicyKey, enabledDocumentSignaturePolicySchema } from "../domain/document-signature-policy";
import type { signaturePreparationDraftSchema } from "../domain/document-signature-preparation";
import { nativeSignatureRecipientPayloadSchema } from "../domain/document-signature-command";
import { DocumentAccessError, DocumentConfigurationError, DocumentConflictError } from "../domain/document-command";
import { SignaturePreparationRepository } from "../infrastructure/signature-preparation-repository";
import { openNativeSignatureRecipient } from "../infrastructure/document-signature-recipient-payload";
import { nativeSignatureContext, nativeSignatureOriginalDefinition, assertSignatureOriginalArchive, signatureNativeInputsChanged, presentSignatureParties } from "./document-signature-draft";
import type { DocumentActorContext } from "./document-archive";

type Draft = z.infer<typeof signaturePreparationDraftSchema>;
export const normalizedPreparationDraft = (draft: Draft): Draft => ({ signatureId: draft.signatureId, recipients: [...draft.recipients].sort((left, right) => left.recipientId.localeCompare(right.recipientId)) });
export const signatureProviderScopeHash = (origin: string, teamId: number) => commandFingerprint(["DOCUMENSO", origin, teamId]);
export async function signaturePreparationTargetContext(ctx: DocumentActorContext, tx: TenantTransaction, signatureId: string, action: "view" | "create", env: NodeJS.ProcessEnv = process.env) {
  const repository = new SignaturePreparationRepository(tx, ctx.organizationId), row = await repository.signature(signatureId); if (!row) throw new DocumentAccessError();
  const original = nativeSignatureOriginalDefinition(row), current = await nativeSignatureContext(ctx, tx, original.draft, action, row.id, row.requestedBy);
  assertSignatureOriginalArchive(current, original.snapshot); if (signatureNativeInputsChanged(current, original.snapshot)) throw new DocumentConflictError();
  const source = current.archive.native.resource, rule = await new ConfigRuleRepository(tx, ctx.organizationId).resolve({ key: documentSignaturePolicyKey, asOf: current.archive.now, scopes: [
    { scopeType: "organization", scopeId: null }, ...source.city ? [{ scopeType: "city", scopeId: source.city }] : [], ...source.ownerId ? [{ scopeType: "owner", scopeId: source.ownerId }] : [], ...source.propertyId ? [{ scopeType: "property", scopeId: source.propertyId }] : []] });
  const parsed = enabledDocumentSignaturePolicySchema.safeParse(rule?.value); if (!rule || !parsed.success || current.instance.document.locale === "ar") throw new DocumentConfigurationError();
  const policy = { id: rule.id, version: rule.version, value: parsed.data, originalValue: rule.value }, parties = presentSignatureParties(ctx, current), recipients = [];
  for (const recipient of [...row.recipients].sort((left, right) => left.id.localeCompare(right.id))) {
    const retained = nativeSignatureRecipientPayloadSchema.omit({ displayName: true, email: true }).parse(recipient.sourceSnapshot), descriptor = original.snapshot.recipients.find(item => item.identityHash === recipient.identityHash),
      party = parties.find(item => item.identityHash === recipient.identityHash), identity = retained.identity;
    if (!descriptor || !party || identity.organizationId !== ctx.organizationId || identity.signatureId !== row.id || identity.recipientId !== recipient.id || identity.fingerprint !== descriptor.fingerprint ||
      commandFingerprint(identity.reference) !== commandFingerprint(descriptor.reference) || party.fingerprint !== descriptor.fingerprint) throw new DocumentConflictError();
    const captured = openNativeSignatureRecipient(identity, recipient.emailCipher, env); if (captured.displayName !== party.displayName || captured.email !== party.email) throw new DocumentConflictError();
    recipients.push({ id: recipient.id, identityHash: recipient.identityHash, fingerprint: identity.fingerprint, displayName: captured.displayName, email: captured.email });
  }
  const providerScopeHash = signatureProviderScopeHash(policy.value.account.origin, policy.value.account.teamId), fingerprint = commandFingerprint({ signatureId: row.id, signatureCommandHash: row.commandHash, native: current.fingerprint, policy, providerScopeHash, recipients: recipients.map(({ id, identityHash, fingerprint }) => ({ id, identityHash, fingerprint })) });
  return { repository, row, original, current, policy, recipients, providerScopeHash, fingerprint };
}
export async function nativeSignaturePreparationContext(ctx: DocumentActorContext, tx: TenantTransaction, draft: Draft, action: "view" | "create", env: NodeJS.ProcessEnv = process.env) {
  const target = await signaturePreparationTargetContext(ctx, tx, draft.signatureId, action, env), { current, row, policy } = target;
  if (target.recipients.length !== draft.recipients.length || draft.recipients.some(layout => !target.recipients.some(recipient => recipient.id === layout.recipientId))) throw new DocumentConflictError();
  const active = draft.recipients.filter(layout => layout.role === "SIGNER" || layout.role === "APPROVER");
  if (policy.value.signing.order === "SEQUENTIAL" && (active.some(layout => layout.signingOrder < 1) || new Set(active.map(layout => layout.signingOrder)).size !== active.length)) throw new DocumentConflictError();
  const recipients = draft.recipients.map(layout => { const recipient = target.recipients.find(recipient => recipient.id === layout.recipientId); if (!recipient) throw new DocumentConflictError(); return { ...recipient, layout }; });
  const candidate = signatureRequestMetadataSchema.safeParse({ reference: row.id, title: current.version.title, locale: current.instance.document.locale, signingOrder: policy.value.signing.order, methods: policy.value.signing.methods, delivery: policy.value.signing.delivery,
    file: { name: current.version.admission.fileName, sha256: current.version.admission.sha256 }, recipients: recipients.map(recipient => ({ name: recipient.displayName, email: recipient.email, role: recipient.layout.role, signingOrder: recipient.layout.signingOrder, fields: recipient.layout.fields })) });
  if (!candidate.success) throw new DocumentConfigurationError(); if (new Set(recipients.map(recipient => recipient.email.toLowerCase())).size !== recipients.length) throw new DocumentConflictError();
  const metadata = candidate.data, contractHash = commandFingerprint(metadata), fingerprint = commandFingerprint({ target: target.fingerprint, contractHash });
  return { ...target, recipients, metadata, contractHash, fingerprint };
}
export function signaturePreparationReviewFingerprint(ctx: DocumentActorContext, draft: Draft, current: Awaited<ReturnType<typeof nativeSignaturePreparationContext>>) { return commandFingerprint({ actorId: ctx.actorId, draft, source: current.fingerprint, cap: captureAuthorizationCap(ctx.authContext) }); }
