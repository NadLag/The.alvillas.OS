# ADR0207: Version-bound expiry history and configured private reminders

Expiry changes attach to an actual immutable file or generated document version.
Every set, correction or cancellation appends a revision with its previous native
revision, actor command, current/held authorization, original source facts and
configuration. Existing versions, signed artifacts and financial rows are never
rewritten. Signed archive artifacts remain system-owned; the underlying original
document carries business expiry. Existing staff-document reminders stay intact.

The shared document context enforces source, template, financial, signature,
counterparty and field access. Metadata edits require independent document edit
authority. Review binds the actual version and previous expiry revision; durable
actor nonces recover lost acknowledgements without appending another change.
History and receipt reads recheck authority after their final private audit.

The existing dispatcher polls; business dates, document type eligibility, civil
send time, stages, repetition and change admission budget come from explicit
configuration. Organization calendar data handles local dates. Current effective
versions supply reminders; future amendments do not prematurely replace current
versions. A missed tick catches up once to the current configured occurrence.
No threshold, retention period, recipient, channel or legal interpretation is
selected implicitly.

Immutable occurrence receipts bind the expiry revision, configuration and routing
versions, current independently authorized recipients and actual shared outbox
references. Repeated ticks recover the same receipt. Inbox availability, delivery
and navigation retain current source and financial access; private document titles,
storage URLs and bytes do not become notification payloads. Clearing an expiry or
archiving/replacing its source preserves history while withdrawing eligibility.

The implementation reuses config_rule, authorization, audit, outbox, notifications
and the signed dispatcher. New business tables force tenant RLS and append-only
guards. Forward-only populated-clone verification protects every prior column,
tuple and migration checksum before staging acceptance. Retention policy and
legal/signing decisions remain separate owner-approved requirements.
