# 0071 — Configured idle upload expiry and fenced recovery

Accepted: 2026-10-25

An unfinished photo can outlive its temporary transport parts while its original offline evidence operation remains pending. Expiring the business operation or changing its idempotency key would risk lost work or duplicate evidence. Keeping every abandoned transport forever would prevent device and storage hygiene.

Use the existing `config_rule` resolver for `field.upload_lifecycle`. Its required `openUploadIdleAfterMinutes` is an explicit duration or `null`. Missing configuration and explicit disable leave OPEN uploads intact. Organization, city, property and effective agreement scopes use the existing canonical scope repository. No business duration is supplied in code.

The existing signed outbox cleanup job performs bounded tenant-scoped lifecycle work. Server activity and outstanding signed PUT leases protect active transfers. Expiry closes only redundant transport, records the effective policy version in the row and an append-only system audit, and retains the original manifest, actor, device, local ID and evidence operation. Physical cleanup continues to respect the complete signature and request window. Permanent evidence is never deleted by this job.

After physical cleanup, the currently authorized, assigned original actor can restart the same manifest under the same upload ID and a new transport generation. Recovery is audited with the old policy, activity, lease and cleanup timestamps. Generation one retains the existing storage paths and legacy response shape; opted-in clients receive generation metadata. Later generations have distinct temporary paths. A stale part request, completion, cleanup response or client acknowledgement cannot advance a newer transfer. Database transition guards and tenant/actor/task locks fence concurrent expiry and recovery. Business attachment keeps its original nonce and applies once.

Real PostgreSQL coverage exercises absent/disabled/future scoped policies, live leases, duplicate expiry and recovery, current assignment and permissions, changed manifests/devices, tenant isolation, generation guards, one final evidence attachment, and a late DELETE acknowledgement after a new transfer has started. Browser, full CI and authenticated staging acceptance remain required before F-FLD-20 can be DONE.
