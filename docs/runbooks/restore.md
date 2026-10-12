# Restore Runbook

Purpose: restore ALVILLAS OS from a PostgreSQL backup without rewriting financial history silently.

## Preconditions

- Owner approval is required before any production restore.
- Identify target environment: dev, staging, or production.
- Confirm backup source, timestamp, PITR window, and expected data-loss window.
- Production restore must be rehearsed on staging before production execution.

## Staging Rehearsal

Automated local/CI rehearsal:

```bash
npm run rehearse:restore
```

This creates disposable PostgreSQL databases, applies migrations, writes rehearsal evidence, runs `pg_dump`, restores into a fresh database, re-runs migrations, and verifies the restored migration/audit evidence.

1. Provision an empty staging PostgreSQL database.
2. Restore the selected backup or point-in-time snapshot into staging.
3. Run `npm ci`.
4. Run `npm run prisma:migrate:deploy` against the restored staging database.
5. Run `npm run test:integration` with `TEST_DATABASE_URL` pointed at the restored staging database.
6. Run ledger integrity checks before exposing staging to users.
7. Record the backup timestamp, restored database id, migration state, and verification output in the PR or incident ticket.

## Production Restore

1. Put the application in maintenance mode or block writes at the edge.
2. Confirm no background workers are dispatching outbox jobs.
3. Restore the approved backup through the database provider.
4. Run forward-only migrations with `npm run prisma:migrate:deploy`.
5. Verify `/api/health`, tenant isolation, audit append-only behavior, and ledger integrity.
6. Re-enable workers after the database and app are verified.
7. Re-enable traffic.

## Never

- Never restore over production without owner approval.
- Never edit financial rows to "fix" balances after a restore.
- Never delete audit, ledger, posting, payment, payout, or reservation history.
