# Original receivable party assignments

F-FIN-25 binds an explicitly selected guest, owner, supplier or person to an actual original posted ownership debit. The tenant-scoped typed party reference remains the historical identity. Current reservation guests, booking-channel listings and money-location accounts cannot substitute for that identity or source.

The effective-dated `finance.receivables` and `finance.receivable_assignments` rules select the original claim accounts and permitted party types. Due dates are explicit or explicitly unscheduled. The system supplies no statutory payment term, legal debtor inference or default account classification.

Assignments divide the exact original posting amount using Money. Intent and original-source locks serialize retries and competing assignments. The source lock shares the original journal-reversal lock. A review fingerprint binds the actual source, current policies, selected debtor and active allocations; a changed review requires another review.

Assignment and release tables are forced-RLS, tenant-linked, immutable history. Corrections append a release and a separately reviewed replacement. Every admission requires an attributed audit and atomic domain event. Classification creates no journal, posting, payment or editable balance. Original financial movements and row versions remain untouched.

The repository's tenant-policy check requires explicit table declarations. A forward migration declares the identical policies directly, preserving the already admitted migration. Rollback qualification compares policy expressions, roles, commands, forced flags, existing row versions and guard definitions before admission; no checker is relaxed.

Both held caller restrictions and fresh stored financial authority apply before source access and at the final boundary. Salary-source access is independently required for the organization aggregate. Party-name discovery additionally requires the appropriate unconditional guest, owner, supplier or team permission. Historical receipt reads retain their original policy evidence after current configuration changes.

The existing private HTTP boundary, field serializer and command/recovery hook are reused. Only a random nonce scoped to the actual organization and account survives a browser reload. Successful acknowledgement and recovery must match the original nonce and operation. Financial data stays in memory and is cleared on connection loss or denial, with fresh receipt checks on focus.

Collection allocation, aging, reminders, exports and complete financial/staging acceptance remain required for F-FIN-25. This increment does not mark the feature DONE.
