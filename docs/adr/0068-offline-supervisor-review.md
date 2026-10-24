# 0068 — Durable supervisor reviews use the existing field queue

Status: Accepted

Supervisor validations must retain the reviewed assignee, critical task version,
checklist, reason and operation nonce across disconnects and cold reloads. An
automatic rebase could attribute work to somebody the validator never reviewed.

Add separate supervised snapshots and drafts to the existing tenant/account-owned
Dexie database. The additive version-four upgrade preserves existing device
identity, photo Blobs, upload acknowledgements, cursors and pending operations.
Each audience has its own cursor and publication generation. Revoking validation
access invalidates supervised reads without deleting the employee's own pending
work. Logout or session revocation continues to wipe the complete owner cache.

Queue the canonical `field_task.proxy_validate` operation through the existing
Sync API and native transactional authorization/audit/outbox service. A saved
draft supplies immutable review provenance; enqueuing cannot silently replace its
nonce, assignee or critical version. Current server permissions still determine
whether offline work is accepted. Validator identity comes from the authenticated
session, never from a client payload.

A changed assignment/version or rejected/conflicted operation requires explicit
review and a new nonce. The user reconfirms the current checklist. Successful
acknowledgement of that reviewed replacement resolves the actionable conflict
while retaining the original failed operation, payload and result in local
history. Stale acknowledgements cannot affect a recreated database or another
account's operation, even if a local sequence number is reused.

The anonymous offline shell routes supervised work to its separate cache. Public
CacheStorage continues to contain only anonymous shells and static assets.
Assigned work and supervised work share the existing sync drain and background
registration; business actions have no parallel implementation. Native online
validation continues to use its existing server action, while cached reviews use
the queue. Optional native evidence remains available before online validation.
