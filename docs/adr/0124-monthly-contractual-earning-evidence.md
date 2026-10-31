# ADR 0124 — Monthly contractual earning evidence

Date: 2026-10-31

Feature: F-FIN-24

## Context

Specification §49 attaches compensation to the actual role assignment and includes monthly contracts. A completed task is evidence for a per-job earning; it cannot establish a whole monthly contractual earning. Monthly work must also retain the original rates when a contract changes during the month or a role is subsequently retired.

## Decision

Extend the existing compensation run, cost, claim, recognition and settlement chain with a distinct `PER_MONTH` earning source. Its durable source identity is the actual assignment plus calendar month. A source retains its real property, job, city or region scope when present. Company contracts carry no property, job or completion event. There is no synthetic operation task, second salary table or stored balance.

Require an explicit organization `staff.compensation_monthly_earnings` rule containing an IANA timezone, complete-month or complete-eligible-day coverage, first-eligible-day or daily-effective rate selection, and rounding at the period total. No legal, tax or statutory proration default is inferred. Only completed calendar months can be retained. Every calendar boundary must agree between the application and PostgreSQL. Exact `Money` arithmetic weights eligible calendar days and rounds once after division by the actual month length.

Append one immutable tenant-scoped witness per actual source date, referencing the canonical contract and configuration rows. The run also freezes the chosen policy and complete daily eligibility. SQL admission checks the actual assignment, geography, effective rate and configuration for every day, conserved period amount, complete witnesses, attributed audit and outbox receipts. Existing per-job source identities and checks remain in place.

Within an operation, contracts share the validated month calendar. Source witnesses reuse its already checked instants, and paginated evidence shares the frozen policy calendar. Witnesses are inserted through one parameterized repository statement; database admission still validates every row. Query and calendar-call regression checks cover actual contracts on 500 properties.

Historical salary access requires the current actor's authority for each original contract amount and the complete beneficiary amount at every retained source instant. Business and audit reads use the same canonical witness references. Later retirement preserves past earned eligibility; changing an earning date, actual coverage, rate or rule requires a new source. Submission prevents two active claims for the same assignment and month, even across distinct runs.

Company costs reuse the existing configured company allocation and approval engine. They require independent unconditional organization financial authority and cannot invent owner or guest money. Real property costs retain the existing property allocation engine. Recognition uses the existing balanced posting recipe and adds monthly assignment and period dimensions. Payments, wallet offsets and their append-only reversals continue to derive outstanding ownership from postings.

## Consequences

The private monthly creation endpoint and existing run, cost and claim screens can handle genuine monthly evidence. EN, FR and AR views explain actual covered days, applied rate versions and calculation choices. Financial values stay in authorized private responses and in-memory client state.

Migrations are forward-only. Migration 99 adds the source and witness structure; migration 100 gives its already tenant-isolated witness policy the repository's required canonical name. Previously applied SQL is preserved. Qualification includes rollback-only source attacks, current authority changes, actual company and property recognition, payment and reversal, populated upgrade preservation and restore checks.

The new policy has no default. Its production activation requires all active readers and the selected application rollback release to support monthly sources and nullable operational references before monthly writes are enabled.

These contractual earnings do not determine statutory payroll, withholding, tax or social contributions. Such decisions remain behind the existing configuration and financial interfaces.
