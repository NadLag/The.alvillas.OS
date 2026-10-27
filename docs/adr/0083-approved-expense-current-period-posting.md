# 0083 — Approved expense posting after period close

F-FIN-05 and handbook G.3.12 require adjustments after close to post in the current open period with a reference to the closed one. An approved, unposted historical expense uses the existing expense posting command and ledger. Its original invoice date, submitted allocation, effective agreement versions and completed approval remain unchanged.

The operator explicitly chooses current-period posting and supplies a reason. The command requires the existing expense payment and financial creation permissions plus independent financial override authority on the source. It checks caller restrictions and stored grants again after the period lock, using PostgreSQL time. Approval remains a separate requirement. Retries bind to the original actor, version, reason and posting mode.

An immutable tenant-scoped evidence row links the expense, new journal, closed calendar and exact closing decision. PostgreSQL verifies the approved source, frozen source timezone, current open posting date and both atomic reasoned audits. Existing expense posting guards still enforce the original funding, allocation, currency and dimensions. Financial viewers can inspect the adjustment evidence; expense-only access does not expose it.

Migration 64 adds evidence and forward guards without rewriting existing financial or audit rows. Upgrade verification retains the source and clone and compares values and row versions. This increment handles approved, unposted expenses; corrections to already posted amounts and remaining source workflows still belong to F-FIN-05. It does not complete that feature or waive CI, merge or authenticated staging acceptance.
