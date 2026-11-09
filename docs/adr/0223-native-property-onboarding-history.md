# ADR 0223 — Native property onboarding history

The onboarding wizard orchestrates the existing domain services. An Owner remains the Core Owner, and agreements remain the existing management-agreement records and configuration rules. Creating another identity or financial model would split their history and authorization.

The wizard stores an immutable tenant-bound session and consecutive native revisions. Each admitted revision captures its command, original identity and reason with the existing platform AEAD and a purpose bound to the organization, session, revision, canonical Owner, actor, nonce and approved policy. The existing strict private key-ring validator is shared through the platform; the CRM entry point retains its contract and original tests. No new cryptography or fallback key is introduced.

Review pins the native source, previous revision, approved configuration and held authorization. Admission locks the command and session, rechecks actual stored grants using the PostgreSQL clock, calls the canonical Core service and appends the wizard revision, identifier-only audit and outbox in one transaction. A source witness includes the Owner tuple and transaction version, so even a same-transaction modification with an unchanged timestamp invalidates publication. Replaying a nonce recovers its original outcome without creating another Owner.

SQL enforces tenant references, append-only history, the current predecessor, approved policy, actual canonical creation or linking, and matching atomic audit/outbox records. A session cannot commit without its first native step. Subsequent step producers extend these guards through ordered migrations; a completion checkbox or caller-supplied activation state cannot substitute for a producer.

Historical reads decrypt the captured revision after current authorization checks. Retiring the admission policy does not erase history or prevent recovery of an admitted command. Payout setup, financial configuration, operational activation and delivery readiness keep their independent permissions and native producers. Go Live remains closed until the delivery/readiness producer admits a release.
