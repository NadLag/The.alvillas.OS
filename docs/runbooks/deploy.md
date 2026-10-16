# Deploy and Promotion Runbook

## Scope

ALVILLAS OS uses its own Vercel project and database. Never deploy this repository to the legacy `alvillas.com` project.

## Staging

The staging project is `the-alvillas-os`.

`main` deploys to the staging URL. Preview deployments are for pull requests only; branch pushes without a pull request are skipped by the Vercel ignored-build command in `vercel.json`.

Before a staging deployment is accepted:

1. Confirm the Vercel project is `the-alvillas-os`.
2. Confirm `DATABASE_URL` and `DIRECT_DATABASE_URL` point to the independent staging database.
3. Run `prisma migrate deploy` against that database.
4. Run first-admin bootstrap only for a new database; preserve existing account credentials.
5. Verify `/api/health`, login, tenant isolation, RLS, structured logging, and staging Playwright smoke tests.

### Inngest background execution

Use the existing `ALVILLAS OS` organization and its custom `ALVILLAS OS Staging` environment (`staging`). Store `INNGEST_EVENT_KEY` and `INNGEST_SIGNING_KEY` as Vercel **Preview Secrets**, and `INNGEST_ENV=staging` as Preview Config. These credentials must not target Production or Development.

The official SDK serves `/api/inngest`. Sync the permanent staging endpoint after deployment and confirm exactly one function: `dispatch-outbox` within app `alvillas-os` (runtime slug `alvillas-os-dispatch-outbox`), with a cron and `alvillas/outbox.dispatch.requested` trigger. A signed GET verifies discovery; unsigned, tampered and expired requests must be rejected. Preview always uses cloud signature verification.

On 2026-10-15 the owner approved a Deployment Protection Exception confined to `the-alvillas-os-staging.vercel.app`. Use the plain permanent `/api/inngest` URL for synchronization; ALVILLAS authentication and SDK signatures remain mandatory. Production and other previews retain their protection. Alias share links redirect to establish a browser cookie and do not authenticate Inngest's cloud HTTP callbacks. Check JSON content and the expected application response, since a followed Vercel login redirect can return HTTP 200. Do not configure a share token as `VERCEL_AUTOMATION_BYPASS_SECRET`, or broaden the exception. Confirm consecutive cron runs after deployment: timer events have no `event.id`, so a function-wide event-ID admission limit would block future ticks.

The dispatcher executes the existing consumers and returns dispatched, failed and skipped counts. Delivery failures remain in the tenant outbox with retry timestamps and safe diagnostics; the cron recovers due rows. Inspect both the Inngest run and the corresponding outbox/device history before reporting success. An API acknowledgement does not prove browser display or record opening. Keep external delivery IDs IN-PROGRESS until their real provider journey passes.

### Scheduled email digests

Use a Resend sending-only key restricted to the verified ALVILLAS sending domain. Configure `RESEND_API_KEY`, `EMAIL_FROM` and `RESEND_WEBHOOK_SECRET` privately in this project's Preview environment; create a dedicated staging webhook for `email.delivered`, `email.failed` and `email.bounced` at the permanent `/api/webhooks/resend` endpoint. No production DNS changes are authorized by staging setup. The endpoint verifies Svix signatures and timestamps against the raw body, then matches the tenant, digest and provider references. Provider acceptance and confirmed delivery are separate history states; unsigned requests must fail.

The existing minute dispatcher schedules due digests. User schedules, locale, IANA timezone and quiet hours live in notification preferences; `notification.digest.delivery_policy` controls batch size, defaults and retry limits through the config editor. Account email/channel consent and current record access are rechecked before sending. Empty batches send nothing. A preference or content change cancels an immutable pending request. Terminal failures require investigation; never replay a prepared request outside its configured window or clear its durable notification claims.

Use the runtime in `.nvmrc` for local verification and deployment builds. The `timezone_data` readiness check must pass with IANA 2026c or later. Older Node/ICU databases use Morocco's former offset; digest consent, scheduling and sending refuse those databases. Upgrade the runtime instead of changing the user's timezone or substituting a fixed UTC offset.

For acceptance, use an existing authorized account with an owner-controlled real inbox, save a future schedule, let cron deliver exactly one digest, and verify its signed delivery receipt, localized body, authorized record links and unchanged history after duplicate replay. Restore the original account preferences after the staging exercise. Keep F-NTF-07 IN-PROGRESS until real delivery is verified. Never use a simulated provider response as staging evidence.

## Production

Production promotion is manual and requires owner approval.

Before production promotion:

1. Confirm the target is the ALVILLAS OS production project, not `alvillas.com`.
2. Confirm a fresh database backup or restore point exists.
3. Apply forward-only migrations with production approval.
4. Exercise the tested staging build.
5. Promote only the tested build.

Rollback follows [rollback.md](rollback.md).
