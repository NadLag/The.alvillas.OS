# 0082 — Accounting period controls

F-FIN-34/35 and handbook G.2–G.3 require monthly locking and privileged, reasoned, time-boxed reopening. Reuse the existing ledger, authorization, configuration resolver, Money and audit writer.

An immutable tenant-scoped month freezes its timezone, UTC boundaries and policy version. Append-only CLOSE/REOPEN events retain the predecessor, actor, reason, request key, resolved policy and balanced journal snapshot. The organization explicitly configures `finance.accounting_periods`; there are no default business limits or schedules. PostgreSQL computes month boundaries and reopening deadlines. The posting guard uses database time, so expiry needs no scheduled job and replay cannot extend a window.

Financial inserts acquire a shared organization advisory lock; close/reopen acquire its exclusive counterpart before checking current stored grants and the caller's restrictions. Closing waits for in-flight writers and snapshots their committed journals. Writers waiting behind close see the resulting lock. The database also rejects raw closed-date inserts and requires an attributed audit and complete snapshot for each control event. Financial audit contents retain independent financial-view and export checks.

Migration 62 adds control records and guards without rewriting existing financial or audit rows. A local pre-application SQL-generation failure rolled back completely; its failed migration row and original SQL were retained, then the corrected unapplied migration was applied. The applied migration remains immutable. Upgrade evidence checks existing values and PostgreSQL row versions on a retained database clone.

Ordinary adjustments after close must reference the old journal and post in the current open period (G.3.12). They do not implicitly reopen the source period. These controls do not complete F-FIN-05 or waive its remaining acceptance gates.
