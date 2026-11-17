# ADR 0274 — Reviewed counts on the original inventory stream

Status: Accepted

F-INV-06 adds the administration counting workflow to the existing immutable stocktake observations, stock revision cursor and adjustment movement. The existing nullable property/task/configuration references already support company locations. There is no second catalog, stock balance, journal or reconciliation engine.

A review binds the actual item/location identities, held/current authority, physical/reserved/damaged quantities and revision. Publication locks the existing stream and repeats that review. A stale revision requires a refreshed expected position and a new explicit review; the entered count remains available for comparison. A matched observation advances the revision without an adjustment. Physical counts retain reservations and damaged quantities rather than silently releasing or repairing them.

Native inventory viewing and creation permissions govern the workspace. Any variance additionally requires independent inventory adjustment authority. The final write fence rechecks those original permissions after audit/outbox work. Field-device authorization and offline conflict/recovery remain unchanged.

The original stocktake stores workspace command provenance. Its actor-bound session nonce recovers the original acknowledgement; an unrecorded nonce is closed atomically against delayed publication. Additive migration 295 requires the original observation, adjustment, audit and receipt to commit together and preserves receipt source fields while permitting ordinary delivery metadata. Existing applied migrations and observations are unchanged.

History filters original property scopes before pagination, follows PostgreSQL timestamp/ID ordering and presents exact integers without financial values. Existing quantity reconciliation and the Variance Center accept these original observations, including company locations. Their operational source adapter retains current/held inventory and property authority; variance interventions require adjustment authority. Field-task source rules remain intact. No expense, reimbursement or financial posting is created by a physical count.
