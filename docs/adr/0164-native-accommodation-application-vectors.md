# 0164 — Native vectors for partial accommodation applications

An application consumes actual held guest funds. A booking quote supplies a limit and source evidence; it does not create an unfunded owner payable. Recognition eligibility and original owner/rule snapshots remain responsibilities of the native financial source workflow.

Reuse the reservation engine's existing owner allocations, commission calculations and posting builders. Compute the difference between its canonical targets before and after an application. This preserves the original engine's exact result across partial amounts, including the commission cent that independently rounded small applications could otherwise lose. The difference helper selects no owner, rate, recognition event or accounting policy.

Keys retain account, currency, bucket and complete native dimensions, with JSON key order ignored. Differences use only `Money` arithmetic. Negative differences become positive postings on the opposite side; zero differences create no posting. This also represents native co-owner cent reallocations without changing earlier rows. Exact original opposites and any necessary subsequent ownership adjustment remain separate immutable financial events. No synthetic target or balance is persisted.
