# ADR 0061: Temporary photo-part cleanup

Date: 2026-10-24

Status: Accepted

Cleanup removes only redundant transport parts after a verified permanent photo is ready, attached, or its upload has been cancelled. It never deletes permanent evidence or business rows. Existing private R2 tuple validation computes every temporary key from organization, upload and part index. The immutable manifest bounds the part count. Failed or lost DELETE acknowledgements leave the durable cleanup marker unset; concurrent retries accept missing objects and commit the marker once.

Part signing persists a monotone expiry under the same upload lock used by completion. The R2 signature uses the captured issuance time, so a delayed process cannot mint a newer signature beyond that lease. Cleanup waits for signature validity plus the bounded PUT transport interval before deleting. Pre-lease closed rows receive the complete existing signature window from their last update. Forward-only migration 48 adds the nullable infrastructure timestamp and database guards without rewriting existing rows.

A separate signed Inngest function polls for eligible rows and retries failures. Keeping it separate prevents a storage outage from blocking business outbox dispatch. Queries remain tenant scoped and bounded; public events cannot choose arbitrary storage keys. A monotonic transport budget defers unstarted work before the function deadline. Failed rows rotate behind older pending work, preventing a permanently failing prefix from starving later uploads. This is transport cleanup, not a business retention schedule. Open uploads and local review Blobs remain intact; configurable queue-age and abandoned-work policy remain F-FLD-20.
