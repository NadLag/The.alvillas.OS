import { EmailRequestError } from "@/platform/providers/real";
import {EmailAttachmentValidationError} from "@/platform/providers/email-attachments";
export {recipientKey} from "./email-recipient";

export function emailIdempotencyKey(event: { type: string; organizationId: string; id: string }) {
  return `${event.type.startsWith("identity.") ? "identity-email" : "notification"}:${event.organizationId}:${event.id}`;
}

export function emailFailure(error: unknown) {
  if(error instanceof EmailAttachmentValidationError)return{status:null,retryable:false,code:"provider_rejected",retryAfterMs:0};
  const status = error instanceof EmailRequestError ? error.status : null;
  const conflict = error instanceof EmailRequestError && error.code === "invalid_idempotent_request";
  return { status, retryable: !conflict && (status === null || status === 408 || status === 409 || status === 429 || status >= 500),
    code: conflict ? "idempotency_conflict" : status === 429 ? "rate_limited" : status === 401 || status === 403 ? "provider_authentication" : status ? "provider_rejected" : "provider_unavailable",
    retryAfterMs: error instanceof EmailRequestError ? error.retryAfterMs : 0 };
}
