import type { SignatureRequestObservation } from "@/platform/providers/signature-contract";
import type { decodeDocumensoWebhook } from "../infrastructure/documenso-webhook";
import { DocumentConflictError } from "../domain/document-command";

type Facts = ReturnType<typeof decodeDocumensoWebhook>;
/** Recipient events and cancellation cannot invent a native completed signature or financial no-effect proof. */
export function classifySignatureWebhook(facts: Facts, actual: SignatureRequestObservation) {
  if (facts.requestId !== actual.requestId || facts.reference !== null && facts.reference !== actual.reference || facts.recipients.some(recipient => !actual.recipients.some(value => value.id === recipient.id && value.role === recipient.role))) throw new DocumentConflictError();
  const required = actual.recipients.filter(recipient => ["SIGNER", "APPROVER"].includes(recipient.role)), complete = actual.status === "COMPLETED" && required.some(recipient => recipient.role === "SIGNER") && required.every(recipient => recipient.signingStatus === "SIGNED" && recipient.signedAt !== null);
  let kind: "SENT" | "VIEWED" | "DECLINED" | "EXPIRED" | "OBSERVED" = "OBSERVED";
  if (facts.event === "DOCUMENT_SENT") { if (actual.distributionMethod !== "EMAIL" || !["PENDING", "COMPLETED"].includes(actual.status) || !actual.recipients.some(recipient => recipient.role === "SIGNER" && recipient.sendStatus === "SENT")) throw new DocumentConflictError(); kind = "SENT"; }
  if (facts.event === "DOCUMENT_OPENED") { if (!facts.recipients.some(recipient => recipient.readStatus === "OPENED" && actual.recipients.some(value => value.id === recipient.id && value.readStatus === "OPENED"))) throw new DocumentConflictError(); kind = "VIEWED"; }
  if (facts.event === "DOCUMENT_REJECTED") { if (!["PENDING", "REJECTED"].includes(actual.status) || !facts.recipients.some(recipient => recipient.signingStatus === "REJECTED" && required.some(value => value.id === recipient.id && value.signingStatus === "REJECTED"))) throw new DocumentConflictError(); kind = "DECLINED"; }
  if (facts.event === "RECIPIENT_EXPIRED") { if (actual.status !== "PENDING" || !facts.recipients.some(recipient => recipient.expiresAt && recipient.expirationNotifiedAt && Date.parse(recipient.expiresAt) <= Date.parse(recipient.expirationNotifiedAt) && Date.parse(recipient.expirationNotifiedAt) <= Date.parse(facts.createdAt) && required.some(value => value.id === recipient.id && value.expiresAt && Date.parse(value.expiresAt) === Date.parse(recipient.expiresAt!) && value.signingStatus === "NOT_SIGNED" && value.signedAt === null))) throw new DocumentConflictError(); kind = "EXPIRED"; }
  if (facts.event === "DOCUMENT_COMPLETED" && (!facts.completedAt || facts.status !== "COMPLETED" || !complete)) throw new DocumentConflictError();
  if (["DOCUMENT_SIGNED", "DOCUMENT_RECIPIENT_COMPLETED"].includes(facts.event) && !facts.recipients.some(recipient => recipient.signingStatus === "SIGNED" && recipient.signedAt && actual.recipients.some(value => value.id === recipient.id && value.signingStatus === "SIGNED" && value.signedAt && Date.parse(value.signedAt) === Date.parse(recipient.signedAt!)))) throw new DocumentConflictError();
  return { kind, completionObserved: complete };
}
