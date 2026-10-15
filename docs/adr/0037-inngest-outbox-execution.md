# Inngest executes the existing outbox dispatcher

One `dispatch-outbox` function is served through the official Inngest Next.js SDK at `/api/inngest`. Its cron recovers due work every minute; a durable dispatch-request event can select one organization. Each organization runs in its own durable step and uses the existing notification, push and identity delivery consumers, retry metadata and authorization rechecks. Failed delivery counts remain visible; later cron runs retry only due rows. Infrastructure exceptions use Inngest retries.

Dispatch requests contain an organization ID and an outbox event ID. The worker reloads that reference under `withTenant`, requires its dispatch-request type and rejects foreign or failed references. Forwarded event data contains only those two references, keeping recovery codes and business contents inside PostgreSQL. The Event API id includes the tenant and immutable source ID. Its acknowledgement must contain a nonempty event-ID list and successful status before the outbox marks forwarding complete.

The existing HTTP drain and Inngest share a PostgreSQL transaction advisory lock per organization. Independent drains therefore cannot forward the same pending source concurrently; consumer idempotency still covers retries after uncertain network acknowledgement. Inngest step memoization and event deduplication supplement durable database state.

Cloud signatures are always verified on deployed Preview and Production environments, even if a development flag is accidentally present. Preview uses the staging environment's independent event/signing keys and permanent staging origin. Production configuration and promotion are separate owner actions. Unverified provider delivery remains IN-PROGRESS.
