# ALVILLAS OS Infrastructure Cost Register

Status: planning register for P0-25. This file tracks expected recurring services and approval gates. It does not approve purchases, subscriptions, production deployment, or paid tiers.

P0-25 approved policy:

- No fixed monthly infrastructure cost ceiling.
- Infrastructure and service expenses are approved case by case.
- Current vendor prices are time-sensitive and must be checked against official pricing before any paid commitment.
- The owner must approve each paid service, tier, subscription, domain, certificate, add-on, or production hosting commitment before purchase.

## Recurring Service Register

| Area | Preferred service or pattern | Initial estimate status | Paid approval gate |
|---|---|---|---|
| App hosting | Vercel | No paid tier approved. Use the leanest tier compatible with staging/production requirements after current pricing review. | Required before paid Vercel plan, production deployment, or add-on purchase. |
| Database | Managed PostgreSQL | Provider and paid tier not selected. Estimate depends on storage, backup/PITR, branching, and production availability requirements. | Required before creating a paid database, enabling paid backups/PITR, or committing to a provider. |
| Object storage | Cloudflare R2 through `StorageProvider` | No paid tier approved. Estimate depends on document/photo volume, signed PDF archive size, and retrieval patterns. | Required before paid storage usage, domain/bucket production setup, or lifecycle/replication costs. |
| Email | Resend through `EmailProvider` | No paid tier approved. Estimate depends on owner reports, invitations, Guest Hub emails, statements, and notification volume. | Required before paid email tier or high-volume sending. |
| Background jobs | Inngest | No paid tier approved. Estimate depends on iCal sync frequency, report generation, workflows, automation rules, and retries. | Required before paid workflow/job tier. |
| Monitoring | Sentry | No paid tier approved. Estimate depends on frontend/backend/workflow event volume, retention, and alerting needs. | Required before paid monitoring tier. |
| Authentication | Auth.js / mature auth layer | Library choice is approved as architecture; any paid identity provider, SMS, MFA, or passkey service is not approved. | Required before paid auth/SMS/MFA/passkey provider. |
| Signatures | Self-hosted Documenso preferred, behind `SignatureProvider` | Owner preference recorded, but total recurring cost is blocked pending legal signature validation, certificate/trust requirements, security operations, maintainer, hosting, backup, and update plan. | Required before Documenso hosting, certificate/trust purchase, paid signature provider, or production signature activation. |
| Domains and DNS | Production domain/subdomains | No purchase or production DNS change approved in this register. | Required before domain purchase, DNS provider charges, or production DNS changes. |
| Backups and recovery | PostgreSQL and object storage backup/restore | Estimate depends on selected providers, retention policy, legal/privacy requirements, and restore targets. | Required before paid backup/PITR/replication services. |

## Approval Record

| Date | Service | Decision | Owner | Evidence |
|---|---|---|---|---|
| 2026-10-10 | Infrastructure budget policy | No fixed monthly ceiling; case-by-case approvals required. | Business owner | Prompt 009 owner decision recorded in `docs/PHASE_0_DECISION_REGISTER.md` P0-25. |

## Current Blockers

- P0-01 incorporation/bank evidence remains unresolved.
- P0-05, P0-06, and P0-08 privacy/retention decisions may affect storage, backups, signed URLs, and deletion/archive costs.
- P0-07 and P0-23 signature legality/security/maintenance decisions may affect Documenso hosting and certificate/trust costs.
- P0-09, P0-10, and P0-12 accounting decisions may affect exports, retention, close evidence, and reporting infrastructure.
- Production service selection must wait until Phase 0 and Phase 1 gates pass.
