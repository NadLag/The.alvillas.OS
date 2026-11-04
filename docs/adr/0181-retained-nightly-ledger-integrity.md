# 0181 — Retained nightly ledger integrity

The integrity checker rebuilds positions with the existing exact Money operations from original postings. It compares each account and transaction with independent PostgreSQL aggregates, then checks location balances against ownership claims and the company net position separately for each currency. It stores verification receipts and source fingerprints, never replacement financial rows or editable balances.

The configured local time, page size, finding limit and account classifications belong to config_rule. The configured rule's original principal must retain complete organization financial authority. Source reads use a repeatable database snapshot. A separate final transaction rechecks current stored authorization, configuration identity and the captured original journals before publishing a receipt and its audit. A unique organization, policy and local date admits one receipt, including concurrent attempts.

Native append-only source fingerprints bind the complete original journal and its ordered postings. A database trigger rejects a fingerprint that does not match an existing sealed journal in the same tenant. Later runs compare retained fingerprints before adding previously unseen originals. First capture establishes the baseline; it does not invent evidence about an earlier state. Existing journal, posting, tenant and period guards remain mandatory.

Closed-period checks compare the latest CLOSE snapshot with the current original period data. A later authorized REOPEN can legitimately add movements before its deadline; those movements must not be reported as corruption merely because the period was closed earlier. The native posting calendar continues to enforce the permitted window.

Finding details are bounded while all movements and failures are counted. A truncated diagnostic list cannot turn a failed or incomplete check into a successful receipt. Rejected publication rolls back its receipt, newly captured source metadata and audit together, preserving original financial data and its PostgreSQL tuple versions.
