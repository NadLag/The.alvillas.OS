# 0078 — Assigned field cash custody

Date: 2026-10-26

Status: Accepted implementation decision

F-FLD-17 records cash physically received for an assigned job. F-FIN-11 and handbook G.3(9) require custody to remain separate from earned revenue. Collection therefore uses the existing financial transaction and posting repositories: debit the collector’s CASH_CUSTODY account and credit UNALLOCATED_COLLECTIONS. It does not invoke accommodation revenue allocation or modify derived balances.

An append-only, tenant-scoped cash receipt links the existing task, collector, property, reservation and journal. Its provenance retains the reservation’s original financial snapshot, including effective agreement versions. Assignment locks serialize collection; current account permissions are reloaded after acquiring the lock. A single transaction commits the balanced journal, receipt, audit and PaymentReceived outbox event. Tenant foreign keys, row security and deferred database guards protect these links.

The existing field draft and operation stores retain cash without another queue or IndexedDB store. Device/operation keys survive cold reload and lost acknowledgments. An opaque task revision detects concurrent device submissions. A failed attempt stays immutable: explicit review either records a separate additional collection with a new key or confirms a matching existing receipt with a reason. Confirmation audits the review and creates no financial movement. Pending cash can accompany offline task completion; the shared drain sends completion only after the cash operation succeeds. Unsubmitted drafts and unresolved failures require review.

Cash handover, deposits, retained authorized expenses and returns remain F-FIN-11 requirements. Native expense production remains an F-AUT-03 acceptance dependency. Neither is completed by this collection increment. Required CI, merge and authenticated staging remain independent acceptance gates.
