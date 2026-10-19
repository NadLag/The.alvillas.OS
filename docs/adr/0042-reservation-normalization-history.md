# 0042 — Reservation sources and immutable confirmation history

Reservations extend the existing tenant-bound model, property booking channels, configuration resolver, finance engine, audit writer and outbox. Calendar feeds reference the property channel's encrypted endpoint. No PMS or second credential store is introduced.

Adapters normalize iCal, generic and provider CSV, and direct inputs. Calendar feeds never supply inferred guest identities, prices or payouts. Unavailable events become calendar blocks. Identity uses property, source and external identifier; dates provide the fallback when an identifier is absent. Conflicting source classifications require review. Malformed or unsupported calendars fail atomically; partial responses cannot increment missing-entry counters.

The existing signed minute dispatcher claims due feeds with database leases and bounded concurrency. Conditional HTTP responses retain identities and do not imply cancellation. Configurable successful-sync absence counts flag future entries for an explicit keep/cancel decision. Failure diagnostics exclude endpoints and upstream bodies. Calendar and Command Center exceptions expose failures and overlaps within current authorization scopes.

Property locks serialize imports, direct creation, changes and overlap detection. Optimistic reservation versions reject stale edits; content fingerprints, source identities and idempotency keys prevent repeated imports and financial postings. Lifecycle transitions adjust pending tasks while preserving performed work and frozen configuration. Guest contact matching follows explicit merges; ambiguous contacts require human review.

Confirmation captures financial rules, ownership and commission through the existing finance service. Unknown calendar amounts remain null. Changes append reservation revisions and financial snapshots; prior versions remain immutable at the database layer. Subsequent receipts retain confirmed ownership and commission. Refunds append balanced compensating ledger transactions through the existing reversal service. Cancellation never deletes or rewrites financial history.

All new business tables have organization identifiers, forced RLS and tenant-bound references. Revision, snapshot, sync-run and import-batch history is append-only. Guest and financial presentation require separate scoped permissions. Portfolio queries batch policy resolution and paginate reservations; desktop, mobile and RTL use the same authorized services.
