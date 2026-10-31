# ADR 0128 — Hourly earning units and original contract witnesses

Hourly financial runs use an explicit `staff.compensation_hourly_runs` policy. Each earning unit is one actual validated completed-work source. Its intervals and every effective contract segment contribute exact integer-weighted Money before one final rounding for that earning. Runs retain the configured completion calendar and aggregate the resulting source amounts through the existing employee claims and financial lifecycle.

Overlap between sources is a separate explicit policy choice: reject overlapping actual intervals for one person, or allow independently validated source earnings. Neither choice has a default. Within each work source, the retained original work-time policy still requires coherent nonoverlapping intervals and its actual validator. New operational policies do not rewrite earlier approved work.

Every earning retains actual foreign keys to its work evidence, approval decision, intervals, contracts and configuration versions. All original rate segments and whole beneficiary totals require independent held and current financial authority. Operational access does not grant financial access. Later corrections append source and financial history through the existing correction boundaries.

No applied SQL is edited. Financial admission guards and migration qualification must verify complete original witnesses and exact Money independently of JSON snapshots before the new earning kind is admitted.

An assignment referenced by an hourly earning keeps its original person, role, scope and start date. Those attributes cannot be rewritten after a retained hourly witness exists; changing them requires retiring the assignment and appending its replacement. Retirement, grant expiry, archival and linking or unlinking an account remain available. This protects historical authorization at the original contract scope while continuing to derive authority from real tenant-scoped relations.
