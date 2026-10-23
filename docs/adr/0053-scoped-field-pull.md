# ADR 0053: Scoped field-work pull

Date: 2026-10-23

Status: Accepted

The field device needs current assigned work, removal of inaccessible cached jobs and updates to linked operational metadata. A task `updatedAt` watermark cannot detect midnight eligibility, property changes or permission changes.

`GET /api/sync/pull` scans assigned metadata in keyset pages of at most 50, ordered by due date and task ID. SQL filtering adapts the existing authorization assignments; every returned record is checked again with `authorize()` and projected with `present()`. Known IDs are revalidated in bounded batches and return changed snapshots or tombstones. Guest names require a current scoped guest permission. Financial and contact fields are excluded from the transport.

Version tags include task, property and reservation versions, authorization scope, edit/guest visibility and the property's business date. Each new pull cycle refreshes eligibility from the server clock and configured IANA timezone. No fixed timezone offset is used. Pagination freezes the cycle's time anchor and excludes tasks created after it; subsequent cycles discover later changes.

Cursors use the existing versioned AES-GCM encryption key ring, with organization and actor as authenticated context. They bind the view, filter and authorization assignments. Page leases expire after five minutes or at the next grant boundary. A checkpoint begins a fresh cycle; bounded known-record checks share the active checkpoint. Modified cursors, another actor's cursors, changed grants and expired pages cannot resume the old scan. No additional credential or schema migration is required.

This increment provides the server pull contract. The device day cache, offline navigation and remaining operation types stay IN-PROGRESS until their own implementation and acceptance are complete.
