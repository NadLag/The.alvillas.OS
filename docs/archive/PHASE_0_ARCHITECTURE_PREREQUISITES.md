# Phase 0 Architecture Prerequisites

Status: documentation-only gate review. This file records which Phase 0 decisions can support technical design and which unresolved items still block implementation gates. It does not mark Phase 0 complete.

## Approved Decisions Available For Design

### P0-13 - Clean-Room Product Boundary

Approved on 2026-10-09 by the business owner in this ChatGPT conversation.

Approved effect:

- ALVILLAS OS is independent and clean-room.
- Independent, clean-room product with no shared code, data or infrastructure.
- The architecture, database, configuration, integrations, deployment, and repository remain ALVILLAS-owned.

### P0-14 - iCal-First Calendar Synchronization

Approved on 2026-10-09 by the business owner in this ChatGPT conversation.

Approved effect:

- V1 uses iCal-first scheduled calendar synchronization.
- ALVILLAS owns the normalized reservation model.
- Duplicate detection, conflict detection, synchronization monitoring, and failure handling are mandatory.
- Airbnb settlement CSV/import is a separate financial data source.
- Guest communication uses manual WhatsApp communication and generated Guest Hub links.
- No internal messaging system is built.
- No PMS/channel-manager purchase, integration, or vendor research is approved for V1.
- Provider and reservation adapters stay extensible for future needs without implementing unnecessary integrations.

### Prompt 009 Decisions And Technical Confirmations

Recorded on 2026-10-10 during the Prompt 009 review.

Approved effect:

- P0-11: V1 tax architecture uses configurable tax hooks and does not hard-code Moroccan tax logic. Accountant-approved tax values remain unresolved under P0-09.
- P0-15: ALVILLAS OS remains the complete production-ready specification across all 17 phases. The 90-day MVP wording is not a scope reduction.
- P0-16: V1 language scope is French and English, with Arabic/RTL architecture ready.
- P0-17: MAD is primary, with multicurrency-capable money models and no single-currency assumption.
- P0-18: V1 payment methods are Airbnb settlement, cash, PayPal, bank transfer, and manual payment recording. Stripe is not a V1 dependency.
- P0-19: Create separate configurable initial templates for Villa 405 and Sultan's House without inventing real property data.
- P0-20: Implement every Master Specification KPI with configurable targets.
- P0-21: Use the Master Specification application stack.
- P0-22: Use the Master Specification managed-service architecture, subject to later paid-service approvals.
- P0-24: Provider abstractions and reservation/source adapters are mandatory V1 boundaries.
- P0-25: No fixed monthly infrastructure cost ceiling; approve infrastructure expenses case by case and track estimates in `docs/INFRASTRUCTURE_COST_REGISTER.md`.

### P0-23 - Partial Signature Preference

Recorded on 2026-10-10 by the business owner.

Approved effect:

- Preferred deployment is self-hosted Documenso, subject to Moroccan legal validation.
- ALVILLAS owns PDF generation.
- Documenso handles the signature workflow through `SignatureProvider`.
- Provider replacement remains possible.

Still unresolved:

- Moroccan legal signature level and Documenso acceptability.
- Certificate/trust requirements.
- Security operations owner.
- Maintenance owner.
- Backup/update plan.
- Final deployment readiness.

## Remaining Phase 0 Gate Requirements Before Application Coding

These unresolved Phase 0 items are essential before Phase 2 application coding or infrastructure setup can safely begin. Technical design may draft against approved sources, but the Phase 0 exit gate is not passed.

| ID | Decision | Why it matters before coding | Allowed design assumption |
|---|---|---|---|
| P0-01 | Confirm incorporation and registration evidence | Phase 0 requires real company evidence before production legal/financial assumptions. | Do not assume registration, tax IDs, social security registration, or bank accounts are complete. |
| P0-02 | Legal frame for owner money held by ALVILLAS | Owner ledger, owner portal money views, payouts, and custody/reconciliation need legal validation. | Model ownership vs custody and audit trails, but do not activate production owner-money handling. |
| P0-03 | Final owner management agreement | Owner onboarding and agreement signing need lawyer-reviewed wording. | Model versioned agreements/documents, but do not use final legal text. |
| P0-04 | Final guest agreement and house rules | Guest Hub legal flows need approved wording. | Model guest agreement and house-rule acceptance, but do not activate final production legal content. |
| P0-05 | CNDP/Law 09-08 guest data and ID obligations | Guest data and ID storage need privacy/legal validation. | Model restricted sensitive document storage and retention hooks. |
| P0-06 | Guest registration and ID storage rules | Required fields, access limits, retention, and deletion need legal advice. | Model configurable forms and sensitive-document access controls. |
| P0-07 | Moroccan signature level and provider acceptability | P0-23 depends on this; owner/guest signing cannot be production-ready without it. | Keep `SignatureProvider` and Documenso preference abstracted and replaceable. |
| P0-08 | Retention and privacy/legal compliance policies | Storage, signed URLs, backups, deletion, and archive behavior need policy. | Model retention-policy hooks; do not hard-code unapproved retention periods. |
| P0-09 | VAT, commission invoicing, tourist tax, owner-statement treatment | Production tax/accounting configuration needs accountant validation. | Build configurable tax/accounting hooks only. |
| P0-10 | Accountant export formats | Export contracts and accounting handoff need accountant acceptance. | Draft export groups from the Master Specification; final fields need accountant approval. |
| P0-12 | Monthly closing and locking rules | Ledger finalization, adjustments, reopening, and statements need accountant-approved rules. | Model close/lock state machines; do not enforce unapproved accounting policy. |
| P0-23 | Documenso legal/security/maintenance completion | Signature deployment, certificates, maintainer, and security operations remain unresolved. | Design `SignatureProvider`, ALVILLAS PDF generation, and signed PDF archive with replacement path. |

## Legal, Accounting, And Compliance Blockers For Dependent Production Workflows

These items do not prevent documentation-only architecture drafting, but they block dependent production workflows, launch readiness, or final behavior.

| ID | Owner | Blocks |
|---|---|---|
| P0-01 | Business owner | Any production assumption that ALVILLAS SARL registration, tax IDs, social security registration, or company bank accounts are complete. |
| P0-02 | Lawyer | Owner-money legal framing, owner funds handling, owner ledger production use, payouts, and owner money held by ALVILLAS. |
| P0-03 | Lawyer | Final owner management agreement templates, owner onboarding package legal content, agreement signing, and owner agreement document workflows. |
| P0-04 | Lawyer | Final guest agreement, house rules, Guest Hub signing, and guest-facing legal flows. |
| P0-05 | Lawyer/privacy advisor | Guest data and ID document handling, CNDP/Law 09-08 obligations, declarations if required, and sensitive guest document access. |
| P0-06 | Lawyer | Guest registration obligations, required guest registration fields, and ID document storage rules. |
| P0-07 | Lawyer | Legally sufficient signature level, certificate requirements, and whether Documenso is acceptable per document type. |
| P0-08 | Lawyer/privacy advisor | Retention policy, privacy/legal compliance policy, deletion/archive behavior, sensitive documents, and backups containing regulated data. |
| P0-09 | Accountant | VAT, commission invoicing, tourist tax, owner-statement treatment, and production tax/accounting configuration. |
| P0-10 | Accountant | Final accountant export formats, field definitions, report grouping, and accounting handoff. |
| P0-12 | Accountant | Monthly close rules, locking, adjustments, reopening rules, and finalized owner statements/accountant exports. |
| P0-23 | Lawyer and technical owner | Signature legal validation, certificate/trust requirements, maintainer assignment, security operations, backups, updates, and final deployment readiness. |

## Proposed Implementation Assumptions, Not Approvals

- The blueprints can use the Master Specification, Technology & Architecture Decisions v1.1, and recorded Prompt 009 decisions as design defaults.
- Financial models can define configurable hooks, immutable movements, ownership vs custody, and reconciliation patterns, but must not encode unapproved legal/tax treatment.
- Guest ID/document entities can be modeled with restricted access and retention hooks, but exact retention and storage behavior remains blocked by legal/privacy decisions.
- Agreement/document entities can be modeled with versions and signature abstractions, but final contract wording and signature assurance remain blocked.
- The P0-14 iCal decision is approved; richer OTA APIs and WhatsApp Business API remain future extension points, not V1 build requirements.
- P0-25 approves the budget policy only; it does not approve paid services, tiers, subscriptions, purchases, or production deployment.

## Gate Result

- Phase 0 exit gate: not passed. Phase 0 still has unresolved legal, privacy, accounting, incorporation, and P0-23 signature maintenance/security blockers.
- Phase 1 documents: can be drafted and verified from approved sources in this commit, but Phase 1 should not be marked complete until the blueprints are reviewed with the people who do the work and tested on paper against real Villa 405 and Sultan's House data.
- Application code: must not start until Phase 0 approval and the three Phase 1 blueprints are complete.

## Acceptance Criteria For This Prerequisite Review

- P0-13 through P0-25 decisions that are genuinely resolved are recorded with evidence and date.
- Remaining blockers are separated into architecture/coding blockers and later production/compliance blockers.
- Proposed assumptions are explicitly labeled as assumptions, not approvals.
- No legal advice, accountant approval, tax rule, compliance clearance, provider pricing, test result, deployment success, or owner approval is fabricated.
