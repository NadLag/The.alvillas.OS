# ADR 0148: Retained earning source transport

Date: 2026-11-02

Hourly and percentage admission retain their original source snapshots in the existing earning-request repository. Large percentage snapshots contain every original posting and contractual witness. Recursively traversing these objects through the ORM write protocol adds work that does not contribute another financial check.

The repository encodes a source batch once, inserts its explicitly typed columns with a parameterized statement, and retains the original JSON snapshot without converting monetary values through JavaScript numbers. Organization and request identifiers come from the repository boundary. Explicit identifiers, optional references, civil-source instants, decimal values and supplied creation times retain the existing behavior. Original table policies, birth triggers, deferred completeness checks, append-only guards and journal locks still execute. No SQL function, table, financial row or migration history changes.

Admission returns only the persisted identifier, original nonce and request time needed by its caller. Recovery continues to load the complete retained record and enforce original actor, held restrictions and fresh authority. Audits and durable outbox receipts remain in the same transaction. The shared posted-source domain validator is constructed once; each original identifier still passes the same UUID validation.

Qualification uses actual 500-property journals and 1,000 retained witnesses, including complete worker execution, exact Money, replay, tenant fences, forbidden mutations, missing counterparts, counterfeit amounts, swapped slots, grant expiry and audit masking. A rollback fingerprint covers original row values and versions, functions, triggers and RLS settings. Native HTTP capacity keeps its existing two-second p95 and zero-retry gates.
