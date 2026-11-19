# Incident response

Open a restricted incident ticket with the UTC start time, affected environment and surfaces, current revision from `/api/version`, request or job references, symptoms, and the assigned incident lead. Use internal references for financial or personal records. Keep credentials, guest records, recovery codes, and document contents out of the ticket and shared logs.

Page the owner immediately for suspected data exposure, incorrect financial processing, or a nightly ledger-integrity failure. Escalate a widespread production outage to the owner and the affected provider. Keep other incidents in the operating queue with an assigned responder. The lead coordinates containment, records decisions, and verifies recovery. The owner authorizes production database changes and promotion and coordinates any legal, privacy, or financial decisions.

## Provider outage

Compare the provider incident with application `/api/health`, `/api/readiness`, and `/api/version`, then identify the first failed job and its durable receipt. Preserve pending work and isolate only affected scheduled jobs through approved controls. Once service returns, inspect acknowledgements before retrying. Use the original outbox or provider operation reference and verify one delivery or completion per source. Check that the backlog is draining and the failure rate has recovered before resuming normal processing.

## Stuck payout

Freeze further attempts against the affected payout and have an independently authorized finance operator reconcile its application state, original posting references, and the bank or provider receipt. Keep the original payout and evidence while the result is uncertain. A confirmed external payment must reconcile to the existing payout. Ask the owner and accountant to approve any correction through the supported workflow. Posted journals must remain intact.

## Field sync storm

Compare pull and push failures with database saturation and the exact deployed revision. Use affected device and operation references to distinguish transient errors from recorded conflicts. Keep field drafts, photos and operation IDs on the original device. After service recovers, let the app replay the original operations and verify the receipts, photos and tasks before closing the incident. Resolve conflicting physical counts through the field review flow.

## Locked-out administrator

Have the administrator sign in with an existing recovery code via the normal MFA challenge, then use the security workspace to review and replace compromised credentials. If recovery is unavailable, verify the administrator through the owner's approved identity process and involve a separate, authorized identity administrator. If no authorized administrator remains, escalate to the owner before changing production access. Review session invalidation, MFA and passkey enrollment, and the audit trail before restoring administrative work.

## Verify recovery

Use the applicable [rollback](rollback.md), [restore](restore.md), or [ledger integrity](ledger-integrity-failure.md) runbook. Verify the original failing path against the recovered revision or provider, including any affected financial or sync receipts. Record the timeline, evidence, root cause and one owner per follow-up in the incident ticket.
