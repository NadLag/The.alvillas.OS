# Deploy and Promotion Runbook

## Scope

ALVILLAS OS uses its own Vercel project and database. Never deploy this repository to the legacy `alvillas.com` project.

## Staging

The staging project is `the-alvillas-os`.

`main` deploys through the GitHub `deploy-staging` job to `https://the-alvillas-os-staging.vercel.app`. It creates a Vercel Preview deployment; Production is separate. Pull requests also receive previews. Branch pushes without a pull request are skipped by the Vercel ignored-build command in `vercel.json`.

The GitHub `staging` environment requires variables `VERCEL_ORG_ID`, `VERCEL_PROJECT_ID` and `STAGING_DATABASE_IDENTITY`, and secrets `VERCEL_TOKEN` and `STAGING_MIGRATION_DATABASE_URL`. Configure secrets privately; never paste them into chat, logs or Git. The migration secret is the dedicated private preview migration credential, never the application's restricted runtime role. `STAGING_DATABASE_IDENTITY` is the SHA-256 of the preview hostname (without `-pooler`) followed by the URL pathname. Independently compare that identity with the private runtime connection before configuring it. A database move requires updating both entries deliberately.

The migration guard requires this repository's merged main ref, the independent project/team and the approved preview database identity. Builds run remotely so unreadable Vercel Preview Secrets stay in Vercel. The migration credential is never added to application runtime variables. Missing configuration fails deployment visibly. Deployments run serially and recheck current main before migrations and alias assignment. Health, readiness and exact SHA/preview/main metadata must pass on both the new deployment and the permanent alias.

Before a staging deployment is accepted:

1. Confirm the Vercel project is `the-alvillas-os`.
2. Confirm `DATABASE_URL` and `DIRECT_DATABASE_URL` point to the independent staging database.
3. Run `prisma migrate deploy` against that database.
4. Run first-admin bootstrap only for a new database; preserve existing account credentials.
5. Verify `/api/health`, login, tenant isolation, RLS, structured logging, and staging Playwright smoke tests.

For Operations acceptance, refresh the owner's real administrator session interactively and save Playwright state outside Git with a user-only ACL. Do not log passwords, cookies, tokens or MFA codes. Set `STAGING_EXPECTED_SHA`, `STAGING_STORAGE_STATE_FILE`, `STAGING_OPERATIONS_FIXTURE_FILE` and `STAGING_EVIDENCE_FILE` to the verified merged commit and private local files, then run `scripts/staging-operations-verify.ts` or `scripts/staging-operations-management-verify.ts` with `tsx`. The prepared fixture must belong to the independent preview database and an authorized tenant. Exercise actual private R2 photo upload/download, denied unauthenticated download, field checklist completion, separate proxy performer/validator identities, recurrence replay and pause, bulk actions, saved views and EN/FR/RTL desktop/mobile accessibility. Retain business history and evidence; do not delete completed acceptance tasks or uploaded evidence as cleanup.

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

## Team Management

Apply the forward-only Team migration to Preview after a verified backup. The runtime database role needs SELECT and INSERT on `team_compensation`, `team_availability`, `team_document` and `team_wallet`, plus UPDATE on availability and document rows. Revoke UPDATE and DELETE on compensation and wallet links. Forced RLS and database triggers protect tenant references, immutable history, leave conflicts and offboarding. A new `STAFF_WALLET` account represents staff cash custody; organization bank and ownership accounts cannot be linked as staff wallets.

Open Team with the existing administrator to initialize the canonical permission catalog and configurable staff policy. Compensation changes use Team; assignment compensation is excluded from the general configuration editor. Historical versions and financial movements are retained.

Configure `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` and `R2_BUCKET` in Preview using a dedicated private ALVILLAS OS bucket and bucket-scoped Object Read & Write credentials. Uploads pass through the server, validate file signatures and configured limits, then use the existing `ENCRYPTION_KEYS` ring to encrypt the bytes with AES-256-GCM and tenant-bound authenticated context. Keep older key versions for existing documents. R2 stores ciphertext; downloads authorize the current session and decrypt on the server, returning a non-cacheable attachment without exposing storage URLs. Archiving blocks future downloads immediately and retains encrypted history. Do not remove stored business documents as cleanup. The configurable default limit is three million bytes, with a four-million-byte technical ceiling for the hosting request limit.

`staff.management_policy` controls upload limits, private link duration and expiry thresholds. Configure recipients and channels for `staff_document_expiring` in Notification Settings; recipients require current document access and channel consent. The existing signed Inngest minute dispatcher schedules reminders, with durable per-document/expiry/threshold deduplication. No recipient is inferred from an administrative role.

Acceptance must exercise an actual private upload and download, unauthorized access, an expiry reminder and duplicate replay. Keep F-TEM-07 IN-PROGRESS while storage credentials or real provider acceptance are missing. For other Team workflows use labeled staging records, append reversals for any acceptance movements, offboard temporary accounts and verify every original financial row is unchanged.

## Reservations

Apply the additive Reservations migration to Preview after a verified backup. Grant the runtime role SELECT and INSERT on `guest`, `reservation_feed`, `reservation_feed_entry`, `feed_sync_run`, `reservation_revision`, `reservation_financial_snapshot`, `calendar_block`, `reservation_import_batch` and `reservation_exception`. Grant UPDATE only on guest, feed, feed-entry, block and exception tables. Revoke UPDATE and DELETE on revision, financial-snapshot, sync-run and import-batch history. Verify forced RLS and the runtime role's non-bypass attributes.

Reservation calendar feeds reuse each property's encrypted booking channel. The existing signed minute dispatcher schedules due feeds; no additional provider account is required. `reservation.sync_policy` controls intervals, missing-UID review thresholds and stale-health thresholds at organization or property scope. Review failed syncs and suspected cancellations in the calendar or Command Center. Failed and conditional requests never count as missing entries. Pause the feed when retiring an integration; retain its import and sync history.

For acceptance, use labeled properties, import reservation CSV twice, modify dates and confirm preserved revisions, check overlapping dates and same-day turnovers, then cancel with a reason. Verify separate financial and guest permissions. Use an actual HTTPS calendar feed for transport verification and leave amounts and guest identity unknown. Keep any acceptance feed paused afterward. Existing payout imports remain in Reservations and use the finance reconciliation service; financial corrections append reversals.

## Production

Production promotion is manual and requires owner approval.

Before production promotion:

1. Confirm the target is the ALVILLAS OS production project, not `alvillas.com`.
2. Confirm a fresh database backup or restore point exists.
3. Apply forward-only migrations with production approval.
4. Exercise the tested staging build.
5. Promote only the tested build.

Rollback follows [rollback.md](rollback.md).
