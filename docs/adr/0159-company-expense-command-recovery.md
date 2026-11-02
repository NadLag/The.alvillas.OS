# 0159 — Recover company expense commands from native results

Company plan revisions, cancellation and recognized-source associations already have native authorization, audit and history contracts. A response lost after commit must not prompt a second financial action or leave the operator guessing whether a revision committed.

Use a tenant-scoped opaque command nonce and an append-only acknowledgement containing the actual native result identifier and version. Execute the original command and acknowledgement in one transaction. A database guard requires an existing native result belonging to the same organization, plan and author, and a deferred trigger requires the acknowledgement audit. The acknowledgement stores no amount or command payload.

Recovery shares the execution advisory lock. It cannot report absence while the original transaction can still commit. It requires the original actor and current independent company, financial and salary authority. Reuse of a nonce with changed intent fails. Revision and cancellation replay returns the original acknowledgement rather than issuing another versioned native command. Known rejected outcomes are converted only after the entire transaction rolls back.

The browser reuses the existing compensation command hook. Only the scoped opaque nonce may survive a reload; financial intent remains in memory. Native invoices, recognized employee claims, payments, journal entries and their immutable histories remain the financial sources.
