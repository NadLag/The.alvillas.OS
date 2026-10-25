# 0075 — Field issue capture through the existing operation queue

F-FLD-09 requires maintenance reports and optional photos to survive offline
work. Reuse `OperationIssue`, `OperationTaskEvidence`, the field queue, the
resumable upload protocol, task mutation receipts, audit and outbox.

Store the photo and report in one IndexedDB transaction, with distinct immutable
operation keys. Upload and attach the photo before reporting the issue. The
report references the photo operation receipt; the server resolves the verified
evidence and checks its task and creator. A compound foreign key additionally
restricts issue evidence to the same organization and task. Existing issues
remain valid with no photo link.

Issue creation requires explicit `issue:create` authorization plus current
assignment to the task. Existing roles and grants are not broadened. The normal
Identity interface can grant this permission within the employee's job scope.
The optional pull capability is omitted for older clients, preserving their
projection and revision. No additional issue engine, upload service, queue or
IndexedDB schema is introduced.

Lost acknowledgements retry the original keys. Rejected photo/report operations
remain visible and prevent completion of that job; unrelated work can sync.
All unsent form navigation, completion, language and update guards apply to
issue text. Existing account-change and logout wipes cover the same tables.

During the owner-authorized local-first period, `STAGING_DEPLOYMENTS_PAUSED=true`
skips only the external staging job. Every application CI check remains enabled.
This guard does not satisfy authenticated staging acceptance or permit DONE.

The integration checkpoint also reproduced five stocktake pull failures on the
unchanged merged F-FLD-08 source. New pull frames now use PostgreSQL's snapshot
clock, matching the clock that records configuration and movements. Recorded
rows include the cursor's full millisecond and exclude the next millisecond;
agreement effective time and the property's business date are unchanged. The
existing snapshot boundary remains stable across pages. No persisted timestamp
is rewritten. Deterministic clock-lag and microsecond boundary tests accompany
the original stocktake assertions.
