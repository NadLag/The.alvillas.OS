# ADR 0129 — Batch fresh Identity permission simulations

Identity dashboard refreshes load up to twelve permission simulations. Resolving each account in a separate sequential authorization read multiplied the same database query group after role creation, role edits, assignment and suspension. The CI trace showed 14.4 and 16.8 seconds waiting for the first two role refreshes in a 90-second lifecycle journey.

Use the existing repository batch authorization reader once for the selected accounts. A shared account-state converter applies the same security-enrollment checks and scoped-role mapping as individual authorization reads. Each account retains its own active status, MFA requirements, grants, conditions and validity dates. A missing or foreign account receives an empty authorization context. Every dashboard refresh reads current stored state; authority is not cached between reads.

PostgreSQL checks compare batched and individual contexts, bound query count independently of account count, and verify denial after suspension, incomplete MFA, grant expiration and revocation. The original browser timeout and all authentication assertions remain unchanged.
