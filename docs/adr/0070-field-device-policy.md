# 0070 — Configured field queue age

Use the existing `config_rule` resolver for `field.device_hygiene`. The strict
value contains `queueWarningAfterMinutes`; `null` disables the warning and zero
warns immediately. An absent rule supplies no threshold. Organization, city,
property and effective agreement scopes retain the canonical resolution order.

Field pull optionally projects only this operational value and its rule ID and
version onto tasks the caller already may view. Resolve all authorized property
scope groups in one configuration query. Include the projection in opted-in
task revisions so configuration changes refresh otherwise unchanged jobs. A
pull snapshot excludes rule versions recorded after its `asOf`, including later
backdated versions. Existing resolver callers retain their effective-time
behavior unless they explicitly request this recording-time bound.

Optional metadata does not create another authorization audience. Preserve the
encrypted cursor format for client upgrades and rollbacks; organization, actor,
property, assigned/supervised mode, grant stamp and expiry checks still apply.
Binding the metadata flag to the cursor initially reproduced loss of an unsent
draft: the client's established invalid-cursor recovery clears that audience's
drafts. The regression now exercises real cursor encoding/decoding and cache
refresh and requires the original draft to survive without a reset.

Capture the current policy alongside a newly queued operation or photo in its
existing IndexedDB transaction. This optional, unindexed metadata needs no
database version change. Reusing an operation key retains its original row,
payload, policy version, photo bytes and retry state. Own and supervised work
retain their separate cache tables and authorization audiences.

Derive a local advisory warning from unresolved, account-owned entries. A
current cached policy takes precedence, including explicit disable; an absent
cache falls back to the queued snapshot. Client time measures display age only.
It never decides authorization, business timestamps, expiry or execution. A
local timer updates the warning without polling the server. The warning neither
blocks work nor retries, deletes or changes queued operations.

Closed-upload cleanup remains governed by its existing policy. Retaining or
expiring abandoned OPEN uploads requires a separate configured policy and is
not implied by this warning threshold.
