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

The official SDK serves `/api/inngest`. Sync the permanent staging endpoint after deployment and confirm exactly one `alvillas-os-dispatch-outbox` function, with a cron and `alvillas/outbox.dispatch.requested` trigger. A signed GET verifies discovery; unsigned, tampered and expired requests must be rejected. Preview always uses cloud signature verification.

Protected staging callbacks use a privately stored share token confined to the permanent staging alias. Synchronize with the endpoint URL containing its `_vercel_share` query parameter; the SDK preserves that query in registered callback URLs. This alias token is not a project-wide automation bypass and must not be configured as `VERCEL_AUTOMATION_BYPASS_SECRET`. Keep token-bearing URLs out of logs, PR descriptions and shell arguments. This does not change production protection or application authentication.

The dispatcher executes the existing consumers and returns dispatched, failed and skipped counts. Delivery failures remain in the tenant outbox with retry timestamps and safe diagnostics; the cron recovers due rows. Inspect both the Inngest run and the corresponding outbox/device history before reporting success. An API acknowledgement does not prove browser display or record opening. Keep external delivery IDs IN-PROGRESS until their real provider journey passes.

## Production

Production promotion is manual and requires owner approval.

Before production promotion:

1. Confirm the target is the ALVILLAS OS production project, not `alvillas.com`.
2. Confirm a fresh database backup or restore point exists.
3. Apply forward-only migrations with production approval.
4. Exercise the tested staging build.
5. Promote only the tested build.

Rollback follows [rollback.md](rollback.md).
