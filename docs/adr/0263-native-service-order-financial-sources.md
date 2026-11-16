# ADR 0263 — Native order financial source identity

Status: accepted for implementation; application, database, UI and acceptance work remain in progress under F-SVC-03. No provider or production activation is authorized by this decision.

The canonical operation task already uniquely identifies its order. Actual native collections identify their existing financial source, provider-cost bindings, immutable allocation admissions and sealed recognition/reversal journals. Reuse those identities and services rather than adding another command ledger, payable, editable balance or accounting engine.

For a collection linked to a canonical order, native admission must use that order's immutable service and currency identity and actual property/reservation/task. Independently held and current order/source rights precede disclosure. Forward migration263 applies the identity check to new admissions and recognitions without rewriting earlier financial rows. Native reversals remain possible under their existing exact-opposite guards, including correction of a previously incorrect decision.

The financial source identity uses the independently scoped financial order grant. It does not require access to the guest directory or operational order interface. Historical source reads and nonce recovery repeat that financial order authority while retaining access to original corrections and reversals.

Collection and actual validated work remain separate prerequisites. Catalog internal cost and a quote are estimates or agreed terms, never evidence of collected funds or incurred cost. Existing supplier-invoice and employee-compensation services supply actual recognized costs. Existing allocation policy continues to select its configured version at actual completion and creates its revenue, owner and tax postings exactly once through its original source and command guards.

Order financial reads derive recognized revenue, original provider cost, ownership, tax and margin only from active native recognition journals and their validated original admissions. Reversed recognitions contribute nothing. Bounded pages label their totals as page totals; they never imply that a partial page is the entire order balance. Financial history and source rights remain independently protected, and no production legal, tax, retention or financial default is introduced.
