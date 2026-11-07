import type { SignatureProvider } from "@/platform/providers";
import { createHash } from "node:crypto";
import { captureSignatureRequest, assertSignatureRequestObservation, signatureRequestHasCompletedActions, type SignatureRequestMetadata } from "@/platform/providers/signature-request";
import { DocumentConflictError } from "../domain/document-command";
import { validateGeneratedPdf } from "../domain/document-pdf";
import type { EnabledDocumentSignaturePolicy } from "../domain/document-signature-policy";
import { readOriginalSignatureProviderRequest, signatureProviderBoundary } from "./signature-provider-boundary";
import { assertSignedPdfPreservesOriginal, documentPdfPageCount } from "./document-pdf-metadata";

type Options = { env?: NodeJS.ProcessEnv; provider?: Pick<SignatureProvider, "readSignatureRequest" | "downloadSignatureRequest" | "downloadSignatureCertificate">; providerOrigin?: string };
/** Read an existing complete original and both authenticated artifacts; no mutation endpoint is available. */
export async function readCompletedSignaturePackage(account: EnabledDocumentSignaturePolicy["account"], metadata: SignatureRequestMetadata, requestId: string, maximumBytes: number, options: Options) {
  const first = await readOriginalSignatureProviderRequest(account, metadata, requestId, options); if (!signatureRequestHasCompletedActions(first.observation)) throw new DocumentConflictError();
  const { provider } = signatureProviderBoundary(account, options), itemId = first.observation.items[0].id, input = captureSignatureRequest({ ...metadata, file: { ...metadata.file, bytes: first.originalPdf } }),
    signedReceipt = await provider.downloadSignatureRequest({ requestId, reference: metadata.reference, itemId, version: "signed" }), signed = { ...signedReceipt, bytes: new Uint8Array(signedReceipt.bytes), observation: structuredClone(signedReceipt.observation) },
    certificateReceipt = await provider.downloadSignatureCertificate({ requestId, reference: metadata.reference }), certificate = { ...certificateReceipt, bytes: new Uint8Array(certificateReceipt.bytes), observation: structuredClone(certificateReceipt.observation) };
  if (signed.requestId !== requestId || signed.itemId !== itemId || signed.version !== "signed" || certificate.requestId !== requestId) throw new DocumentConflictError();
  for (const file of [signed, certificate]) if (createHash("sha256").update(file.bytes).digest("hex") !== file.sha256) throw new DocumentConflictError();
  if (certificate.sha256 === signed.sha256 || certificate.sha256 === metadata.file.sha256) throw new DocumentConflictError();
  for (const actual of [signed.observation, certificate.observation]) { if (!signatureRequestHasCompletedActions(actual) || (actual.createdAt ? new Date(actual.createdAt).toISOString() : null) !== first.providerCreatedAt) throw new DocumentConflictError(); assertSignatureRequestObservation(input, actual, { requestId, teamId: account.teamId, distributionMethod: "EMAIL", originalPdf: first.originalPdf }); }
  const signedPdf = validateGeneratedPdf(signed.bytes, maximumBytes), certificatePdf = validateGeneratedPdf(certificate.bytes, maximumBytes); await assertSignedPdfPreservesOriginal(first.originalPdf, signedPdf); await documentPdfPageCount(certificatePdf);
  const final = await readOriginalSignatureProviderRequest(account, metadata, requestId, options); if (final.identityHash !== first.identityHash || !signatureRequestHasCompletedActions(final.observation)) throw new DocumentConflictError();
  return { signed: { ...signed, bytes: signedPdf }, certificate: { ...certificate, bytes: certificatePdf }, scopeProof: final.scopeProof, observation: final.observation, identityHash: final.identityHash };
}
