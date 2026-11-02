# Recurring scheduling of approved owner payouts

F-FIN-26 needs durable recurring jobs while retaining the original owner-ledger, agreement, approval and actual-payment boundaries.

The explicit `finance.recurring_payouts` rule enables scheduling from actual APPROVED payouts. The current configuration author must hold fresh unconditional organization configuration and financial view/edit authority. Each source supplies its frozen eligible instant, original amount, beneficiary and approval history. The job reuses `scheduleOwnerPayout`; it neither reconstructs approval nor derives another balance. No synthetic payment reference, external bank call or PAID transition is generated.

The existing signed dispatcher polls. A tenant/configuration lock serializes bounded batches, while the canonical owner and payout locks protect transitions against human commands. The existing payout state, native scheduling audit and unique `PayoutScheduled` outbox event provide durable recovery and replay protection. An additional attributed audit records the exact configuration version and original payout version. Current source and principal checks run after the writes; revocation rolls back the complete batch, including native audits and outbox. An unavailable tenant principal cannot stop the other dispatcher tenants.

This implementation remains a separate child of unchanged draft PR #130. Recurring company expenses, periodic payout draft creation and complete authenticated staging acceptance remain required before F-FIN-26 completion. No existing migration, financial movement or approval assertion is changed.
