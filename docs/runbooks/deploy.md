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
4. Run first-admin bootstrap with temporary staging credentials.
5. Verify `/api/health`, login, tenant isolation, RLS, structured logging, and staging Playwright smoke tests.

## Production

Production promotion is manual and requires owner approval.

Before production promotion:

1. Confirm the target is the ALVILLAS OS production project, not `alvillas.com`.
2. Confirm a fresh database backup or restore point exists.
3. Apply forward-only migrations with production approval.
4. Exercise the tested staging build.
5. Promote only the tested build.

Rollback follows [rollback.md](rollback.md).
