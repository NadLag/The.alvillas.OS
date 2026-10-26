# 0077 — Resolve native actions from current account grants

F-AUZ-06 requires every entry point to use the deny-by-default authorizer.
The core and finance session adapters supplied bootstrap grants; configuration
and agreement adapters supplied them when stored grants were empty. Real
PostgreSQL regressions reproduced unauthorized financial transactions, owner
creation and configuration creation after grant expiry.

All four adapters now reuse the existing identity account-context loader.
Business callers await its current assignments, scopes, conditions, validity
and enrollment policy. Revoked and setup-required sessions cannot obtain a
business context. Empty assignments never acquire fallback permissions.

Collection access permits discovery of candidates. Creation also checks the
actual new owner/property resource inside its transaction before commit or
audit publication. Denial rolls back the new business rows. Restricted core
pages return the existing not-found surface and hide unavailable creation
forms. Property views do not require access to the owner directory.

Ownership allocation requires both scoped property editing and explicit
financial editing authority. The existing audit writer records its validated
human reason and before/after shares; existing links and historical audits
remain intact. Operational profile and lifecycle permissions remain separate.
