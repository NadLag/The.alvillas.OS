# ADR 0064: Recheck proxy validation data scope

Date: 2026-10-24

Status: Accepted

The supervisor list intersects current task view and validation grants. The shared mutation service previously checked validation alone, so a direct or queued command could still validate a task after its view grant expired or no longer covered the property. A real PostgreSQL regression reproduced the unauthorized completion before the correction.

Require both current view and validation authorization against the same task resource inside the existing mutation transaction, before reading receipts or writing completion, audit and outbox effects. Reuse the existing authorization engine and native proxy service. Preserve separate performer/validator attribution and existing idempotency. No schema, financial-data or production change is required.

The existing PostgreSQL scope-intersection case now also requires direct mutations with disjoint or expired view scope to fail without completing the task or appending a proxy audit. The queued path uses the same transactional service and retains rejected operations rather than changing their original result.
