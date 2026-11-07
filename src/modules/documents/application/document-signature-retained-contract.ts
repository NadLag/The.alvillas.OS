import type { TenantTransaction } from "@/platform/db/tenant";
import { commandFingerprint } from "@/platform/http/command-fingerprint";
import { signatureRequestMetadataSchema } from "@/platform/providers/signature-contract";
import { nativeSignatureRecipientPayloadSchema } from "../domain/document-signature-command";
import { DocumentAccessError, DocumentConflictError } from "../domain/document-command";
import { SignaturePreparationRepository } from "../infrastructure/signature-preparation-repository";
import { openNativeSignatureRecipient } from "../infrastructure/document-signature-recipient-payload";
import { nativeSignatureOriginalDefinition } from "./document-signature-draft";
import { originalSignaturePreparation } from "./document-signature-preparation";

/** A system observation compares only immutable originals; it neither exports a new file nor borrows human grants. */
export async function retainedSignatureProviderContract(tx: TenantTransaction, organizationId: string, intentId: string, env?: NodeJS.ProcessEnv) {
  const repository = new SignaturePreparationRepository(tx, organizationId), intent = await repository.preparation(intentId); if (!intent) throw new DocumentAccessError();
  const original = originalSignaturePreparation(intent), signature = await repository.signatureRecord(intent.signatureId); if (!signature) throw new DocumentAccessError(); const native = nativeSignatureOriginalDefinition(signature), version = await repository.version(signature.documentVersionId), instance = await repository.instance(signature.instanceId);
  if (!version || !instance || !await repository.versionMatchesInstance(version.id, instance.id) || original.snapshot.signatureCommandHash !== signature.commandHash || original.snapshot.document.versionId !== version.id || original.snapshot.document.instanceId !== instance.id || original.snapshot.document.sha256 !== version.admission.sha256 || original.snapshot.document.byteSize !== version.admission.fileSize || native.snapshot.document.sha256 !== version.admission.sha256) throw new DocumentConflictError();
  const recipients = original.snapshot.command.recipients.map(layout => {
    const recipient = signature.recipients.find(row => row.id === layout.recipientId); if (!recipient) throw new DocumentConflictError(); const source = nativeSignatureRecipientPayloadSchema.omit({ displayName: true, email: true }).parse(recipient.sourceSnapshot), descriptor = native.snapshot.recipients.find(value => value.identityHash === recipient.identityHash), captured = original.snapshot.recipients.find(value => value.id === recipient.id), identity = source.identity;
    if (!descriptor || !captured || captured.identityHash !== recipient.identityHash || captured.fingerprint !== identity.fingerprint || descriptor.fingerprint !== identity.fingerprint || commandFingerprint(descriptor.reference) !== recipient.identityHash || commandFingerprint(identity.reference) !== recipient.identityHash || identity.organizationId !== organizationId || identity.signatureId !== signature.id || identity.recipientId !== recipient.id) throw new DocumentConflictError();
    const contact = openNativeSignatureRecipient(identity, recipient.emailCipher, env); return { name: contact.displayName, email: contact.email, role: layout.role, signingOrder: layout.signingOrder, fields: layout.fields };
  });
  if (recipients.length !== signature.recipients.length) throw new DocumentConflictError(); const policy = original.snapshot.providerPolicy.value, metadata = signatureRequestMetadataSchema.parse({ reference: signature.id, title: version.title, locale: native.snapshot.document.locale, signingOrder: policy.signing.order, methods: policy.signing.methods, delivery: policy.signing.delivery, file: { name: version.admission.fileName, sha256: version.admission.sha256 }, recipients });
  if (commandFingerprint(metadata) !== original.snapshot.contractHash) throw new DocumentConflictError(); return { repository, intent, original, signature, version, metadata, policy };
}
