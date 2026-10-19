# ADR 0045: Build staging remotely and isolate migration credentials

Status: Accepted

The staging workflow's environment pull succeeds, but `vercel env run` cannot load project settings with the CI token. Preview secrets are also unreadable through environment pulls, so a runner cannot build with the deployed application's sensitive values.

Build the reviewed merged commit remotely with Vercel's preview environment. Keep the existing private preview migration credential in the GitHub `staging` environment as `STAGING_MIGRATION_DATABASE_URL`, separate from the application's restricted database role. Before running Prisma migrations, require the independent repository, main ref, commit SHA, project and team, and the approved preview host/database fingerprint in `STAGING_DATABASE_IDENTITY`. Credentials never appear in command arguments or output. The migration credential is never sent to Vercel or added to application runtime variables.

Deployment preserves the exact commit SHA and main ref at build and runtime, checks health/readiness/version, and assigns only the permanent staging alias. Recheck all three endpoints on that alias. Deployment does not bootstrap or reset existing administrator credentials. Production workflows and databases remain outside this change.

Changing the preview database requires deliberately updating both the staging secret and its identity fingerprint. Tests reject other repositories, refs, projects, teams and database identities, and verify that malformed credentials are omitted from errors.
