# ADR 0279 — Laundry custody and original physical movements

Status: Accepted

Laundry batch headers and lines preserve original catalog units, physical condition, supplier, optional stay and the actual locations on both transit legs. Planning creates no stock reservation or movement. Batch dispositions describe custody; they do not replace physical inventory balances.

Every physical handoff, damage, confirmed loss and reversal calls the original inventory movement writer in the same tenant transaction as the immutable batch event, attributed audit and actor-bound outbox receipt. Missing observations, washing, rejection and rewash change custody only. Damaged condition follows the original return movement. Confirmed loss requires the independent inventory override grant. No batch result creates a charge, expense, valuation, reimbursement or journal entry.

Custody is derived from append-only changes. Aggregate source quantities are bounded before an event, including inverse changes. Reversal references the complete original event and every original native movement; closure must be reversed before correcting a closed batch. Forced tenant isolation, original source references, immutable receipts and deferred database proof preserve that relationship. An absent command is closed under the same nonce lock used for publication.

Reviews bind original custody, physical streams, source metadata and held/current authority. Publication locks the batch and original stock streams, rechecks the review, and verifies source authority after all effects. Reads and audit bodies retain independent property, stay and supplier permissions. Metadata batches reuse the native source authorizer and witness builder. The private interface clears on visibility, offline and authority changes; storage contains only actor-scoped command nonces.
