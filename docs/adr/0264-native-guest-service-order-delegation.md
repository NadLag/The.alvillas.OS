# ADR 0264 — Native Guest Hub service ordering

Status: accepted for implementation under F-GST-08; end-to-end acceptance remains required. Scope unchanged: all 355 features remain required.

Guest service selection uses the existing signed Guest Hub capability and form-grant history for an explicit staff release of canonical catalog offers. An immutable native-service delegation binds that grant's actual staff authorization cap, catalog and ordering sources, public offer projection and expiry. Every new request repeats the retained and current issuer/source checks and the current reservation, guest, link and release fences.

The public input contains structured service identity, dates, quantity and participants. The server binds property and reservation identity from the authenticated capability and uses the canonical order policy, availability and exact pricing. Public contracts exclude internal cost, providers, allocation/tax recipes, staff caps and client-supplied price or state.

Canonical order creation uses the explicit retained release authority through the existing service-order application service. The same transaction records an immutable guest-origin receipt, scoped original nonce, guest audit event and outbox event linking the actual guest submission and native order. Subsequent task, cost, compensation, allocation and recognition operations retain their existing independent authority and source requirements. The guest-facing boundary exposes the selected offer, its customer-facing price and the bound native order status.

Recovery authenticates the same live guest source and matches the original link/release/nonce before returning a recorded receipt. A lost reply never causes an automatic repeat of a mutation. Public presentation uses explicit field projection and the existing presenter; private configuration never becomes a guest availability probe. Historical native rows remain append-only and tenant-scoped.

Business limits and release/review lifetimes require configuration. Production identity collection, provider activation, billing, deployment settings and production changes remain outside this work.
