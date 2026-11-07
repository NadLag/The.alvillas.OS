import type { z } from "zod";
import { DocumensoSignatureProvider } from "@/platform/providers/real";
import type { SignatureProvider } from "@/platform/providers";
import { commandFingerprint } from "@/platform/http/command-fingerprint";
import { signatureRequestIdSchema, signatureRequestObservationSchema, signatureObservationFactsSchema, signatureMaximumEvidenceBytes, type SignatureRequestReceipt, type SignatureRequestMetadata } from "@/platform/providers/signature-contract";
import { captureSignatureRequest, assertSignatureRequestObservation } from "@/platform/providers/signature-request";
import { DocumentConfigurationError, DocumentConflictError } from "../domain/document-command";
import type { EnabledDocumentSignaturePolicy } from "../domain/document-signature-policy";
import type { signatureProviderEvidencePayloadSchema } from "../domain/document-signature-provider-evidence";

type Account = EnabledDocumentSignaturePolicy["account"];
export function signatureProviderBoundary<T extends Pick<SignatureProvider, "readSignatureRequest">>(account: Account, options: { env?: NodeJS.ProcessEnv; provider?: T; providerOrigin?: string }) {
  const env = options.env ?? process.env; let origin: string;
  try { const value = new URL((options.provider ? options.providerOrigin : env.DOCUMENSO_URL) ?? ""); if (value.username || value.password || value.search || value.hash || !["", "/"].includes(value.pathname)) throw new Error(); origin = value.origin; }
  catch { throw new DocumentConfigurationError(); }
  if (origin !== account.origin) throw new DocumentConfigurationError(); return { origin, provider: options.provider ?? new DocumensoSignatureProvider(env) };
}
export function captureSignatureProviderReceipt(raw: SignatureRequestReceipt): SignatureRequestReceipt {
  if (!signatureRequestIdSchema.safeParse(raw.requestId).success || !(raw.evidence instanceof Uint8Array) || raw.evidence.length < 1 || raw.evidence.length > signatureMaximumEvidenceBytes) throw new DocumentConflictError();
  return { requestId: raw.requestId, evidence: new Uint8Array(raw.evidence) };
}
export async function readSignatureProviderScope(provider: Pick<SignatureProvider, "readSignatureRequest">, account: Account, origin: string): Promise<z.infer<typeof signatureProviderEvidencePayloadSchema>["scopeProof"]> {
  const observation = signatureRequestObservationSchema.parse(await provider.readSignatureRequest({ requestId: account.scopeEnvelopeId, reference: account.scopeReference }));
  if (origin !== account.origin || observation.requestId !== account.scopeEnvelopeId || observation.reference !== account.scopeReference || observation.teamId !== account.teamId) throw new DocumentConfigurationError();
  return { requestId: observation.requestId, reference: observation.reference, teamId: observation.teamId, origin, fingerprint: commandFingerprint(signatureObservationFactsSchema.strip().parse(observation)) };
}
/** Authenticate a captured account and compare the complete existing original through GETs only. */
export async function readOriginalSignatureProviderRequest(account: Account, metadata: SignatureRequestMetadata, requestId: string, options: { env?: NodeJS.ProcessEnv; provider?: Pick<SignatureProvider, "readSignatureRequest" | "downloadSignatureRequest">; providerOrigin?: string }) {
  const { origin, provider } = signatureProviderBoundary(account, options), scopeProof = await readSignatureProviderScope(provider, account, origin), first = signatureRequestObservationSchema.parse(await provider.readSignatureRequest({ requestId, reference: metadata.reference })); if (first.items.length !== 1) throw new DocumentConflictError();
  const download = await provider.downloadSignatureRequest({ requestId, reference: metadata.reference, itemId: first.items[0].id, version: "original" }); if (download.requestId !== requestId || download.itemId !== first.items[0].id || download.version !== "original" || download.sha256 !== metadata.file.sha256) throw new DocumentConflictError();
  const input = captureSignatureRequest({ ...metadata, file: { ...metadata.file, bytes: download.bytes } }), observation = signatureRequestObservationSchema.parse(download.observation);
  for (const actual of [first, observation]) assertSignatureRequestObservation(input, actual, { requestId, teamId: account.teamId, distributionMethod: actual.distributionMethod, originalPdf: download.bytes });
  const providerCreatedAt = observation.createdAt ? new Date(observation.createdAt).toISOString() : null; if ((first.createdAt ? new Date(first.createdAt).toISOString() : null) !== providerCreatedAt) throw new DocumentConflictError();
  const identityHash = commandFingerprint({ origin, teamId: account.teamId, requestId, reference: metadata.reference, providerCreatedAt, original: metadata });
  return { observation, scopeProof, providerCreatedAt, identityHash, originalPdf: new Uint8Array(download.bytes) };
}
