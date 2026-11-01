# ADR 0134: Durable admission of original percentage earnings

Status: accepted for implementation of F-FIN-24. Financial and staging acceptance remains required.

Percentage creation uses the existing earning request, immutable outcome, outbox dispatch, authorization cap, run writer and financial approval paths. Admission retains reviewed intent and original posting evidence; it creates no run, claim, payable or ledger movement. The worker must consume the same nonce, actor, mode, input fingerprint and reviewed economic fingerprint exactly once.

Forward migration 116 makes the existing work-evidence references nullable for percentage sources and adds typed, tenant-owned request posting witnesses. Hourly sources continue to require their actual approved work evidence. Every percentage witness retains its original posting, effective contract, rules and typed scope, including the complete original journal exposure. A security-invoker, security-barrier view exposes the actual run and request witness rows to the shared economic checks. Actual source rows are normalized into the existing validation types without inserting substitute runs or trusting client JSON as authority. Original hourly predicates remain enforced.

Request headers, sources, attributed audit and worker references must be born together. All original journal counterparts and source slots are required. A completed receipt prevents later witness insertion. Witnesses and outcomes are append-only; identity changes require replacement assignments. Forced tenant isolation and composite foreign keys protect every new reference.

Review binds original earned identity, posted amounts, complete journals, actual scopes, effective rates, policy and combined exact rounding. Allowed later assignment retirement or account unlink does not change earned identity. Current source eligibility and held plus fresh financial authority are checked again before worker execution. The source compiler retains its conservative raw fingerprint for checks within a command. Changed economics or expired authority produces an immutable conflict or denial without repricing retained evidence.

Discovery scans at most 25 original posting and contract pairs per page. Continuations are encrypted and bound to actor, tenant, filters and both policies. Every offered choice passes the original complete-journal and salary checks. Human labels require independent access. Review calculates the complete selection before paging its evidence; individual rounded previews cannot replace combined Money calculations.

The EN, FR and AR creation screens reuse the existing private read and durable command hooks. Only the scoped random nonce survives reload. Lost acknowledgements retry exactly the original command, unrelated acknowledgements are rejected, and connection loss clears private details. Posting, recognition, settlement and corrections continue through the established financial lifecycle.

Before local admission, the exact migration bytes passed rollback qualification on an existing 500-property portfolio under a role without RLS bypass. All predecessor values, row versions, functions and migration bytes were preserved. The forward upgrade also preserved all existing business values and row versions and retained a complete predecessor backup. No production database or deployment setting was changed.
