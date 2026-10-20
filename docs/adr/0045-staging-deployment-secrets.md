# ADR 0045: Build staging remotely and isolate migration credentials

Status: Accepted

Preview secrets are unreadable through environment pulls, so a runner cannot build with the deployed application's sensitive values. Vercel CLI also resolves user and team metadata that project-scoped personal access tokens deny.

Build the reviewed merged commit remotely with Vercel's preview environment. Keep the existing private preview migration credential in the GitHub `staging` environment as `STAGING_MIGRATION_DATABASE_URL`, separate from the application's restricted database role. Before running Prisma migrations, require the independent repository, main ref, commit SHA, project and team, and the approved preview host/database fingerprint in `STAGING_DATABASE_IDENTITY`. Credentials never appear in command arguments or output. The migration credential is never sent to Vercel or added to application runtime variables.

Deployment preserves the exact commit SHA and main ref at build and runtime, checks health/readiness/version, and assigns only the permanent staging alias. Recheck all three endpoints on that alias. Deployment does not bootstrap or reset existing administrator credentials. Production workflows and databases remain outside this change.

Changing the preview database requires deliberately updating both the staging secret and its identity fingerprint. Tests reject other repositories, refs, projects, teams and database identities, and verify that malformed credentials are omitted from errors.

Before invoking Vercel CLI or migrations, check the token with three read-only API requests: the authenticated user, the intended team, and the intended project. Validate the returned team/project identities against the same target guard used for migrations. Expose `secrets.VERCEL_TOKEN` only to the authenticated steps under `environment: staging`; use no token argument, file-based authentication fallback or alternate credential variable. Output only resource labels, HTTP statuses, fixed outcomes and a fixed diagnosis. Discard provider response bodies, headers, identities and exception text. A failed or inconclusive check stops staging.

The main-only `Staging authentication check` workflow runs the same diagnostic without deployment, migration or alias assignment. Run it with `gh workflow run staging-auth-check.yml --ref main` after the workflow has passed required CI and merged. The current-main guard rejects stale workflow commits. Successful project access with denied user/team metadata identifies a token that cannot support this CLI flow; the supported correction is team scope `nadirlagnadi-6231s-projects` → `All Projects`, as described in [Vercel's token scoping documentation](https://vercel.com/docs/accounts/access-tokens). A 401 or target mismatch is reported separately and does not imply the same correction. Never retry deployments to diagnose authentication.
