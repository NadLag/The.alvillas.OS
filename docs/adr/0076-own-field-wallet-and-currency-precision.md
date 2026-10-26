# 0076 — Own wallet reads from the shared ledger

F-FLD-16 reads the existing staff wallet and immutable postings through
`TeamRepository`, with `Money` aggregation. It introduces no financial writer,
balance field or parallel ledger. The API derives the person from the verified
actor; it accepts only a history page. It requires an explicit wallet grant for
that person's actual wallet. Operational permissions confer no financial access.
Compensation terms retain their independent permission and effective versions.
Earned compensation and native expense producer acceptance remain dependencies.

Use the existing `withTenant` RepeatableRead option so balances and history share
one PostgreSQL snapshot during concurrent posting. The existing audit writer
records successful reads. Legacy uncategorized postings remain readable.

Cache only the last requested own-wallet page in the existing private cache
state. Identity and incarnation checks reject late requests; existing wipes
clear the same nine stores. Work refresh preserves the current wallet snapshot.
A rejected wallet request clears that snapshot without removing pending jobs.
The latest read nonce also prevents an older allowed response from restoring
financial data after a newer permission denial, including across open tabs.
Public offline shells and Cache Storage contain no wallet figures.

The shared currency formatter converted Decimal to Number and lost valid cents.
Keep exact decimal strings through Intl, as specified by
[ECMA-402 ToIntlMathematicalValue](https://tc39.es/ecma402/2025/#sec-tointlmathematicalvalue).
The existing currency layout and finite-value checks remain. Explicit EN/FR/AR
regressions cover cent loss within the old bound and valid amounts beyond it.
This changes presentation only; no financial row or amount is rewritten.
