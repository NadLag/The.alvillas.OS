# Retain causal review cancellation instants

An employee withdrawal is recorded by PostgreSQL with microsecond precision. The application clock returns a JavaScript Date, which retains milliseconds; a wall-clock step can also place that Date before the retained withdrawal. The existing SQL guard correctly requires cancellation receipts to occur at or after their actual withdrawal source.

For cancellation of an employee review notification, the approval repository selects the greater of the requested instant and the actual same-tenant withdrawal timestamp. It passes the resulting microsecond ISO timestamp directly to Prisma for both resolution and read receipts. Existing resolved receipts and notification identity remain unchanged. Other approval decisions keep their existing timestamp behavior. Missing withdrawal evidence continues to be rejected by the original SQL guard.

The regression uses an actual run, submission, approval, withdrawal and notification. It supplies a clock instant before the real withdrawal, then verifies causal receipts and unchanged notification identity, financial rows, configuration, run witnesses and prior audit history. No financial data, migration or guard is rewritten.
