# Operation task lifecycle and history

Operations use the existing reservation task aggregate, configuration catalog, tenant transaction, authorization, audit and notification services. No parallel task store is introduced.

Every task insert and update creates a database-enforced, append-only version event. Existing tasks receive an initial snapshot without changing their business values. Services set transaction-local actor, request and reason metadata; changes made without this context remain explicitly unattributed. Command receipts bind idempotency keys to the actor, task and input hash, while optimistic versions reject stale commands.

Checklist instances snapshot the selected, resolved configuration version. Template edits never change an existing task's checklist. A proxy completion requires the assigned performer, a different authorized validator, a reason and all checklist items. Performer fields always identify the worker; validator fields identify the supervisor. Terminal tasks cannot be reopened or silently reassigned.
