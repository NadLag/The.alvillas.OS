import type { TenantTransaction } from "@/platform/db/tenant";
import { recheckAccountAuthorization } from "@/platform/authz/current-authority";
import { commandFingerprint } from "@/platform/http/command-fingerprint";
import { captureAuthorizationCap } from "@/platform/authz/authorization-cap";
import { DocumentAccessError, DocumentConflictError } from "../domain/document-command";
import { SignaturePreparationRepository } from "../infrastructure/signature-preparation-repository";
import type { DocumentActorContext } from "./document-archive";
import { originalSignaturePreparation, readSignaturePreparationEvidence } from "./document-signature-preparation";
import { nativeSignaturePreparationContext } from "./document-signature-preparation-context";

/** Sending an existing private draft requires edit authority independently of creation. */
export async function nativeSignatureDistributionContext(ctx: DocumentActorContext, tx: TenantTransaction, preparationId: string, env?: NodeJS.ProcessEnv) {
  const repository = new SignaturePreparationRepository(tx, ctx.organizationId), preparation = await repository.preparation(preparationId); if (!preparation || preparation.phase !== "PREPARE") throw new DocumentAccessError();
  const original = originalSignaturePreparation(preparation), current = await nativeSignaturePreparationContext(ctx, tx, original.draft, "view", env),
    attempt = await repository.preparationAttempt(preparation.signatureId), evidence = attempt?.evidence.find(item => item.kind === "PREPARED");
  if (current.current.instance.document.archivedAt || current.current.archive.native.archived) throw new DocumentAccessError();
  const checks = current.current.archive.privacy.map(dataClass => ({ action: "edit" as const, resource: { ...current.current.archive.native.resource, type: "signature", id: current.row.id,
    documentId: current.current.instance.documentId, assignedUserAccountId: current.row.requestedBy, dataClass } }));
  await recheckAccountAuthorization(ctx, tx, current.current.archive.now, checks, new DocumentAccessError());
  if (!attempt || attempt.intentId !== preparation.id || !evidence || current.fingerprint !== original.snapshot.contextFingerprint || current.contractHash !== original.snapshot.contractHash) throw new DocumentConflictError();
  const privateEvidence = readSignaturePreparationEvidence(preparation, evidence, env), account = current.policy.value.account;
  if (privateEvidence.kind !== "PREPARED" || !privateEvidence.providerRequestId || privateEvidence.providerRequestId !== evidence.providerRequestId ||
    privateEvidence.scopeProof.origin !== account.origin || privateEvidence.scopeProof.teamId !== account.teamId || privateEvidence.scopeProof.requestId !== account.scopeEnvelopeId || privateEvidence.scopeProof.reference !== account.scopeReference ||
    privateEvidence.observation?.reference !== current.row.id || privateEvidence.observation.teamId !== account.teamId || privateEvidence.observation.status !== "DRAFT" || privateEvidence.observation.distributionMethod !== "NONE") throw new DocumentConflictError();
  const retainedPreparation = { intentId: preparation.id, attemptId: attempt.id, evidenceId: evidence.id, commandHash: preparation.commandHash, providerRequestId: privateEvidence.providerRequestId },
    fingerprint = commandFingerprint({ preparation: retainedPreparation, native: current.fingerprint });
  return { ...current, preparation, preparationEvidence: evidence, retainedPreparation, fingerprint };
}
export function signatureDistributionReviewFingerprint(ctx: DocumentActorContext, current: Awaited<ReturnType<typeof nativeSignatureDistributionContext>>) { return commandFingerprint({ actorId: ctx.actorId, delivery: "EMAIL", preparation: current.preparation.id, source: current.fingerprint, cap: captureAuthorizationCap(ctx.authContext) }); }
