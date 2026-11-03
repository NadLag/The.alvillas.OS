# 0160 — Property-attributed financial positions

The locked specification requires a financial view for each property. A mortgage can remain a property expense under the configured accounting treatment. Its presentation must preserve the distinction between money ownership and money location.

Read original sealed journal postings carrying the selected property's attribution. Derive each account's opening and closing position using its stored normal side, with exact Money arithmetic and separate currencies. Keep ownership, location and company entitlement accounts separate. A location's property-attributed position is not that location's complete bank or wallet balance. Whole-invoice or employee-claim payments retain their native settlement scope; the view does not allocate them to a property without original attribution.

Use the existing expense authoring, approval, posting and opposite-entry commands for mortgages and other property costs. The view adds no treatment, principal/interest split, mutable balance or financial table. Native expense, invoice and employee-recognition references link postings back to their actual sources. Archived properties retain their original financial history.

The complete internal report requires explicit property-finance permission, actual property visibility and independent unconditional organization grants for the financial, salary and party sources it combines. Conditional or narrower grants cannot establish complete positions, including for an empty period. Existing document and owner-ledger views retain their own access boundaries. The shared authority definition protects both presentation and financial read-audit output; viewing and exporting remain separate permissions. Every read retains the caller's restrictions and reloads current stored authority.

One PostgreSQL statement derives positions, source fingerprint and the bounded original-posting page from one MVCC snapshot. Encrypted continuation binds organization, actor, property, filters, source and original posting boundary. A changed source or filter requires a fresh first page. Rechecking the source and current authority after the private read audit prevents stale financial output without freezing revocation checks inside repeatable-read isolation.

The existing property calendar defines civil-date boundaries. Query counts must remain constant as the portfolio grows to 500 properties, and every original history row must remain reachable beyond the first page. No financial row or previously applied migration is rewritten.
