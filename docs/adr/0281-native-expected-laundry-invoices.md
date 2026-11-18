# 0281 — Expected laundry invoices from original custody and quotes

F-LND-05 calculates an estimate from the existing laundry batch sequence and the applicable native supplier-price configuration. It does not issue an invoice or post an expense, payment, owner allocation or inventory movement. Those operations retain their existing engines and approval rules.

Supplier quotes may explicitly specify a billable stage (planned, sent, received or washed) and physical conditions. Existing versions remain unchanged. Missing terms or prices prevent admission; an agreed price of zero remains distinct from an absent price. Incomplete stages are labelled provisional. Quantities come from original custody events and net reversals at the retained sequence; all amounts use native Money.

An assessment stores an immutable proof referencing that original sequence, quote, pricing instant and actual property context. A change requires another assessment. The canonical configuration resolver owns scope precedence and retirement. Current and held operational source permissions and independent financial source permissions are required; recording additionally requires the native supplier-invoice creation grant. Audit export requires the corresponding independent source export grants.

Admission locks the original batch and native configuration families, then repeats source and authorization checks. The tenant-scoped append-only record, actor-bound outbox receipt and audit event commit together. Database constraints verify original quantities, rates, exact totals, source identity and transaction provenance. Nonce recovery returns the original receipt or durably closes an unrecorded command. Neither recovery nor correction rewrites the original estimate or financial history.
