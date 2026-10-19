# Configured Operations scheduling and evidence

Task scheduling reuses effective team role assignments, permission grants and approved availability. Candidate authorization is evaluated at the scheduled instant through the shared authorizer. A transaction-scoped crew lock prevents overlapping assignments and bulk write skew across properties. Preferred and fallback ordering, capacity, durations, readiness types, warning windows and generation horizons are ordinary versioned configuration values.

Recurring occurrences use property-local calendar arithmetic and a stable property/series/date identity. Editing a series preserves existing task instances. Pausing may cancel future work that has not started, through the same authorized transition service. Generation and overdue checks run through the existing durable dispatcher.

Management filters are applied with permission scopes before counting and pagination. Saved views belong to one account and never grant access. Bulk commands validate every selected task before applying any change in the transaction.

Task evidence is append-only. Photos use the existing private R2 provider with server-side type, size and hash verification; downloads recheck task access and use private, uncached responses. Notes and reported issues retain their author and task origin. Retry receipts preserve the resulting resource identity. Financial rows and owner credentials are not modified by these operations.

Staff profiles without login accounts retain their performer person identity when a supervisor validates their checklist. Deferred database constraints permit a null performer account only when the completed parent task records proxy completion, its assigned performer and a distinct validator with a reason and timestamp. Existing completion rows are preserved; unaudited person-only writes and later identity tampering fail at transaction commit.
