# ADR0211: Private native lead capture

F-CRM-01 accepts acquisition requests from the website, authorized manual entry
and referrals. Capturing a claim about an owner must not disclose or modify an
existing Person, Owner or Property. Conversion remains an authorized CRM action;
ALVILLAS controls property onboarding.

Use the existing tenant transaction, current and held authorization, configuration,
audit, outbox, rate limiter and versioned authenticated encryption. Store original
contact and acquisition details in an encrypted payload. Bind its AEAD context to
the organization, lead, author, immutable policy version, channel, source and
command nonce. Require explicit versioned 256-bit encryption keys; identity
development fallbacks cannot encrypt acquisition PII. Keep original captures and
their audit history append-only.

Capture sources, required fields, accepted catalogs, contact requirements and
request budgets belong to `crm.lead_capture` configuration. No pricing, retention
schedule, lawful basis or privacy text is supplied by code. Activation requires an
owner-approved processing reference. Website capture additionally requires the
exact configured notice reference and digest to be acknowledged; this records
the acknowledgement without deciding its legal sufficiency.

Resolve the public organization through trusted server configuration. Public
payloads cannot select a tenant, author, existing owner/person, pipeline stage or
representative. Use the active policy author's current explicit authority as the
automation principal and preserve the public origin in audit metadata. Website
responses contain no private CRM record or indication of an existing person.
Manual and referral commands require ordinary authenticated account authority.

An immutable command nonce recovers its original result only after payload and
authority checks. Reusing the nonce for another principal or changed acquisition
details fails closed. Audit and outbox events carry record identifiers and safe
metadata, never contact details or decrypted notes. Read publication uses the
original serializer and fresh authorization fences.

F-CRM-02 retains the eleven approved pipeline stages. Capture starts a new lead;
capture clients cannot assert signature, onboarding or go-live completion.
Downstream transitions must verify their actual native dependencies. Hosted,
security and financial acceptance remain mandatory before any DONE promotion.
