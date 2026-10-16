# Manual WhatsApp notifications (F-NTF-06)

Use the existing notification routing and property config_rule overrides for operational recipients, linked active property owners for owner messages, and the reservation's guest contact for guest messages. Operational recipients must still hold current access to the record through the selected routing assignments; callers need scoped assignment permission to see colleague contacts. Guest and owner access is checked independently from source access and personal fields pass through present().

Reservations capture an optional international guest phone and message locale through the existing create workflow. libphonenumber-js/max validates complete international numbers without country guessing or text extraction. Missing and invalid existing contacts remain actionable errors; no arbitrary recipient override is accepted.

Existing reservation contacts can be corrected in the composer with independent guest edit and reservation edit permissions. Updates persist on the reservation and use the shared audit writer to redact phone values. A transient phone override is never accepted by link generation.

Catalog templates supply EN/FR/AR messages. Reservation messages include only the reference and dates; task messages include the localized title and date. Guest names, contact details, notes, financial data and private access information are excluded. The generated phone and message appear in the authenticated preview only, never in audit metadata or logs.

Preparation and manual opening have separate audit events. A same-origin POST opens a new tab, reloads current scope, contact and routing, and redirects to the fixed https://wa.me origin with encoded text. No provider send, delivery receipt, internal chat, credentials or WhatsApp Business API is introduced. Opening records intent to open, never successful transmission or delivery.

A SHA-256 fingerprint binds opening to the reviewed source, recipient, normalized phone, locale and message. A changed contact or message requires a new preview. Noreferrer form navigation can carry an opaque Origin; only browser-controlled same-origin Fetch Metadata permits that case.
