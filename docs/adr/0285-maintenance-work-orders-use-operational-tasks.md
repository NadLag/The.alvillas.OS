# ADR 0285 — Work orders use the original maintenance task

A work order is an append-only facet of an existing `MAINTENANCE`
`OperationTask`, identified by that same task ID and linked to its original
issue. Registration creates neither a task nor a financial source. Assignment,
priority, scheduling, status, completion and evidence retain their native writers.

Registration checks both original issue and task authority and ancestry, with
review fingerprints, actor-bound nonce recovery, negative closure and atomic
audit/outbox proofs. Independent task access governs list disclosure; general
audit views hide private reasons. A caller may confirm their own immutable
command outcome without receiving a withdrawn task body. Recovery needs only
the issue and retained nonce after a reload.

The interface lives inside the current issue view so its private state is removed
when that view revalidates, becomes inactive or goes offline. Estimate, approval,
actual-cost and invoice integration must use the existing financial and approval
services. Asset references require the native F-AST-01 register.
