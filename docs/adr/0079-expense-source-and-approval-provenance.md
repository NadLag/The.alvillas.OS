# 0079 — Expense source and approval provenance

Date: 2026-10-26

Status: Accepted implementation decision

F-FIN-15–17 and the native expense producer required by F-AUT-03 share one expense source. Drafts use optimistic versions and audited edits. Submission facts have an append-only snapshot; later state changes preserve amounts, currency, property, reservation, purpose, funding and occurrence date. Same-tenant foreign keys and forced row security bind these facts to existing domain records.

ApprovalStage and ApprovalStageRecipient extend the existing ApprovalRequest. They retain ordered positions, configured routing, financial amounts, relevant ownership and attributed decisions. They do not replace the shared approval request, notification or ledger services. A pending stage accepts one final attributed decision with a reason; its original routing and money remain immutable.

Posting recipes reuse the existing expense allocator, owner-share allocator, Money and balanced posting assertion. Independent rounding of a shared one-cent expense previously allocated two cents. The final participating share now receives the exact remainder. Funding and beneficiary accounts remain separate, and every recipe balances in one currency.

The shared owner allocator also caps each proportional allocation at the remaining money. This prevents a negative final share when multiple tiny shares round upward and preserves the existing allocation order. Separately resolved owner expense amounts are not redistributed by ownership a second time. These changes apply to new calculations and rewrite no historical transactions.

Custom approval conditions use the existing bounded automation grammar and evaluator. Base policies and referenced values resolve from one scoped PostgreSQL read using the common configuration resolver. Unknown, unrelated legacy keys remain unparsed and unchanged. Financial occurrence dates resolve to the first instant of the property's local calendar date; skipped dates fail validation instead of selecting another day's rules.

Financial audit presentation resolves the actual expense source. It checks both current and historical amounts before exposing changes, so reducing a draft cannot reveal an earlier amount above a reader’s grant. Draft persistence creates neither a journal nor a submission event. Complete submission, approval, posting and native acceptance remain separate required work; these features remain IN-PROGRESS.
