# Rollback Runbook

Purpose: roll back an application release while preserving database history and forward-only migrations.

## Application Rollback

1. Identify the last known-good deployment and commit SHA.
2. Confirm whether the bad release included database migrations.
3. If no production migration was applied, promote the last known-good deployment.
4. Verify `/api/health`, login availability, and the current phase smoke tests.

## Migration Rollback Policy

- Database migrations are forward-only.
- Do not run destructive down migrations in production.
- If a migration caused production harm, create a new forward migration that preserves data and repairs schema or data shape.
- Any production financial-data repair requires owner approval and a written, auditable procedure.

## Worker Rollback

1. Pause scheduled jobs and outbox dispatchers if they are related to the incident.
2. Deploy the application rollback.
3. Resume jobs only after idempotency and outbox status are verified.

## Post-Rollback

- Keep the failed deployment SHA, rollback SHA, incident time, and verification command output with the PR or incident ticket.
- Add a regression test before retrying the release.
