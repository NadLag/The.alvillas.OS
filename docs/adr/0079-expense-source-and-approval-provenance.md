# 0079 — Expense source and approval provenance

Date: 2026-10-26

Status: Accepted implementation decision

F-FIN-15–17 and the native expense producer required by F-AUT-03 share one expense source. Drafts use optimistic versions and audited edits. Submission facts have an append-only snapshot; later state changes preserve amounts, currency, property, reservation, purpose, funding and occurrence date. Same-tenant foreign keys and forced row security bind these facts to existing domain records.

ApprovalStage and ApprovalStageRecipient extend the existing ApprovalRequest. They retain ordered positions, configured routing, financial amounts, relevant ownership and attributed decisions. They do not replace the shared approval request, notification or ledger services. A pending stage accepts one final attributed decision with a reason; its original routing and money remain immutable.

Posting recipes reuse the existing expense allocator, owner-share allocator, Money and balanced posting assertion. Independent rounding of a shared one-cent expense previously allocated two cents. The final participating share now receives the exact remainder. Funding and beneficiary accounts remain separate, and every recipe balances in one currency.

The shared owner allocator also caps each proportional allocation at the remaining money. This prevents a negative final share when multiple tiny shares round upward and preserves the existing allocation order. Separately resolved owner expense amounts are not redistributed by ownership a second time. These changes apply to new calculations and rewrite no historical transactions.

Custom approval conditions use the existing bounded automation grammar and evaluator. Base policies and referenced values resolve from one scoped PostgreSQL read using the common configuration resolver. Unknown, unrelated legacy keys remain unparsed and unchanged. Financial occurrence dates resolve to the first instant of the property's local calendar date; skipped dates fail validation instead of selecting another day's rules.

Financial audit presentation resolves the actual expense source. It checks both current and historical amounts before exposing changes, so reducing a draft cannot reveal an earlier amount above a reader’s grant. Draft persistence creates neither a journal nor a submission event.

Submission captures the per-owner policies, exact allocation, configured recipients and calendar revenue evidence once. Concurrent original-version retries retain one snapshot, audit and native ExpenseSubmitted/ExpenseOverThreshold event. Reservation expenses require their original commission snapshots; missing historical policy or referenced values fail closed. Current agreements never substitute for missing booking history.

The existing approval form sends the current financial stage ID. A retry of an earlier decision cannot approve a later stage. Financial reads and decisions reload grants after resource locks and authorize the actual expense amount, owner and occurrence date. Notifications target only the current stage's retained recipients. Operational property approval grants confer no financial approval access. Database guards enforce source immutability, ordered recipients, stage/audience fidelity and atomic submission/event/audit records. The shared automation engine reads actual expense sources and binds its approval action to the canonical financial request.

Ordinary booking confirmation also freezes separately configured expense policies and referenced condition values in each new commission snapshot. Existing snapshots are never rewritten. Expense submission can consume the original reservation financial frame when it contains the required historical values; missing values fail closed. Requester role conditions use current scoped assignments independently from the separate permission that authorizes expense creation. They share the bounded condition evaluator.

Percentage approvals read owner-payable revenue within configured property calendar windows. The bank debit on a receipt is excluded from that revenue sum. Financial notification targets retain distinct expense and approval IDs. Channel replay checks the current retained stage and its source event; resolved owners keep access through their own retained stage.

The native property expense form, independent owner authentication, field-account denials, localized financial summary and resolved inbox history have targeted EN/FR/AR desktop/mobile acceptance with zero retries and accessibility checks. Posting, reversals, complete emergency post-hoc notification delivery, final full integration checkpoints, required CI and authenticated staging remain mandatory. Emergency owner bypass is blocked until the required notification workflow is available. These features remain IN-PROGRESS.
