# ADR 0065: Queue supervisor validation through the native transaction

Date: 2026-10-24

Status: Accepted

Add a discriminated `field_task.proxy_validate` operation to the existing version-one sync protocol. Reuse the native proxy command schema and require the originally reviewed task version, performer, complete checklist and reason inside its immutable payload. A legacy base version cannot replace that review. Do not accept caller-supplied validator attribution or financial fields.

Extract the existing native completion body into a transactional helper used by both the native form and sync service. Keep current view/validation scope checks, performer status, explicit version conflict, receipt hashing, separate attribution, notification, audit and `ProxyValidated` outbox behavior together. Capture completion time after locks and checks. Preserve rejected/conflicted sync results and require a new operation for reviewed changes; retries never rewrite the original command.

Use the existing tenant-scoped crew lock before task/performer writes and acquire participant row locks in a stable order. Native and queued submissions sharing a key converge on one receipt and one business effect. Real PostgreSQL cases cover concurrent duplicate delivery, opposing validators, native/queued races, person-only performers, stale review, payload changes, revoked permissions and tenant isolation.

Offline supervisor cache projections, durable drafts and review UI are separate unfinished work. This server increment does not mark F-FLD-12 or F-FLD-15 complete. No migration or financial-data rewrite is required.
