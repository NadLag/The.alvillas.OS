# ADR0172 — Reconcile original inventory observations

Reuse the shared F-FIN-32 evidence plan when an assigned field stocktake commits. Its expected quantity is the locked position retained by the immutable stocktake; its actual quantity is that same stocktake's physical count. The adapter checks the original revision and the identity, tenant, item, location and exact signed delta of the native adjustment. Counts use BigInt and their configured inventory unit, never Money or floating point arithmetic.

A genuine zero observation retains a fingerprint of the native observation and adjustment as evidence for that side. It creates neither a zero movement nor a synthetic source. A changed count references the original executed stocktake adjustment as its action; its variance remains open for the later Variance Center. Exact observations are matched. No tolerance or resolution policy is invented.

Append the complete plan to the existing required stocktake audit event in the same tenant transaction. Existing sync acknowledgements, operation ownership, source rows, movement arithmetic, configuration snapshots, outbox payloads and field permissions retain their contracts. Older audits and observations remain immutable. No new business table, migration, balance or competing ledger is introduced.
