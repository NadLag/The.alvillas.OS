# 0081 — Reasoned journal reversals

F-FIN-05 and master specification section 62 require append-only corrections linked to their original source, with a reason and audit.

Keep the existing ledger, `reverses_transaction_id`, Money, expense void and reservation/OTA refund services. Migration 60 adds guards only for future inserts: one reversal per original, a same-tenant source and actor, an exact opposite posting multiset, and a reasoned audit linking both journals. It changes no existing journal, posting or audit row and does not retroactively validate historical financial data. Forward migration 61 indexes tenant/source reversal lookups; the already applied guard migration remains unchanged.

Economic dimensions, account, currency, amount and bucket stay intact. Only posting-kind and reversal-reference metadata may differ. Reservation correction locks coordinate the existing source services; authoritative stored grants and the supplied context's restrictions are both checked with PostgreSQL time after waiting. A retry must match its original actor, reason and audited journal set. The native reservation refund entry point also checks its immutable revision and reuses that financial authorization on replay.

Adjustments, period closing/reopen and authenticated staging remain separate unfinished requirements. This decision neither grants a generic bypass around expense approval nor marks F-FIN-05 DONE.
