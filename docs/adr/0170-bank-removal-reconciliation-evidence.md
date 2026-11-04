# ADR0170 — Nonmonetary bank removal reconciliation

A bank's DELETE correction is retained evidence that an earlier source movement was removed. It is not a zero-value transaction. Reconcile it against explicitly selected original bank postings and any actual opposite journals through the existing reconciliation entry and shared exact plan. A nonzero difference retains its explicit reason/action and remains open; no posting, automatic write-off or tolerance policy is created.

Append typed BankReconciliationEvidence rows linking the original entry to the exact retained deletion fact. PostgreSQL independently checks its tenant, bank/account identity, currency, fact hash, complete command intent, unambiguous terminal correction family and audit. Every active earlier family association, including a partial monetary association, must be released first. Concurrent admissions share the existing account/source locks; one removal cannot support two active associations. Releasing it appends history and restores its derived availability.

Preserve ordinary command and review shapes when no removal is selected, including property order and recovery fingerprints. The original monetary allocation table remains unchanged. The private editor selects removal records without an amount field and requires review and confirmation. Historical plans retain their original evidence; later competing or unresolved corrections derive SOURCE_CHANGED without rewriting a row.

All applied SQL remains immutable. Migration159 adds the typed evidence, terminal-source predicates and native guard. Migration160 qualifies the guard's native-source alias without modifying the applied159 bytes. Source records, financial journals, prior associations, releases and original audit history remain append-only.
