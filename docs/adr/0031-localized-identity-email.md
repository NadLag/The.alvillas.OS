# ADR 0031 — Localized identity email delivery

Date: 2026-10-14

Feature IDs: F-NTF-01, F-IDN-04, F-IDN-05, F-IDN-09

Identity already creates durable delivery events. Forwarding them to Inngest
alone does not send an email. The previous Resend key also groups distinct
messages to the same recipient together.

The existing dispatcher selects invitation and recovery email handlers, which
render message-catalog templates and call the existing real Resend adapter.
Other events and manual phone delivery retain the existing Inngest path.
Recipient language is stored on Person and used for the email and action URL.

Delivery validates the configured application origin, locale, code-bound path
and expiry before contacting the provider. Invalid or expired messages fail
through the existing retry mechanism. Provider bodies are excluded from errors
because they can contain personal data and recovery codes.

Each outbox event has its own Resend key; retries reuse it. Resend retains keys
for 24 hours, so this does not claim indefinite exactly-once delivery.
See [Resend idempotency](https://resend.com/docs/dashboard/emails/idempotency-keys).
Live delivery acceptance remains required before the provider-dependent IDs
can be DONE. No migration or alternative dispatcher is introduced.

F-NTF-01 closeout (2026-10-16) completes the Arabic catalog and sends session
revocation alerts through the same durable email consumer. These alerts remain
mandatory in email and in-app even when optional preferences or routing are
disabled. The recipient is still the affected active account, with its own
localized security-page link; incomplete MFA enrollment cannot suppress a
security alert. System emails use the shared locale/direction document wrapper.
