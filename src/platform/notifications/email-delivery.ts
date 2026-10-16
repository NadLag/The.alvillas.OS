import { createHash } from "node:crypto";
import { EmailRequestError } from "@/platform/providers/real";

export function emailIdempotencyKey(event: { type: string; organizationId: string; id: string }) {
  return `${event.type.startsWith("identity.") ? "identity-email" : "notification"}:${event.organizationId}:${event.id}`;
}

export function recipientKey(organizationId: string, address: string): string {
  return createHash("sha256").update(`${organizationId}:${address.trim().toLowerCase()}`).digest("hex");
}
export function emailFailure(error: unknown) {
  const status = error instanceof EmailRequestError ? error.status : null;
  const conflict = error instanceof EmailRequestError && error.code === "invalid_idempotent_request";
  return { status, retryable: !conflict && (status === null || status === 408 || status === 409 || status === 429 || status >= 500),
    code: conflict ? "idempotency_conflict" : status === 429 ? "rate_limited" : status === 401 || status === 403 ? "provider_authentication" : status ? "provider_rejected" : "provider_unavailable",
    retryAfterMs: error instanceof EmailRequestError ? error.retryAfterMs : 0 };
}
