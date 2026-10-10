# Phase 0 Architecture Prerequisites

Status: documentation-only gate review. This file records which Phase 0 decisions can support technical design and which unresolved items still block dependent workflows or implementation gates. It does not mark Phase 0 complete.

## Approved Decisions Available For Design

### P0-13 - Clean-Room Product Boundary

Approved on 2026-10-09 by the business owner in this ChatGPT conversation.

Approved effect:

- ALVILLAS OS is independent and clean-room.
- No source-code sharing or dependency on Orbix, HostNow, `D:\alvillas`, `D:\alvillas.com`, or legacy projects.
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
- No PMS or channel-manager purchase, integration, or vendor research is approved for V1.
- Provider and reservation adapters stay extensible for future needs without implementing unnecessary integrations.

## Remaining Decisions Essential Before Application Coding

These remaining Phase 0 decisions are essential before Phase 2 application coding or infrastructure setup can safely begin. Technical design may draft against source-supported assumptions, but those assumptions are not approvals.

| ID | Decision | Why it matters before coding | Allowed design assumption |
|---|---|---|---|
| P0-11 | Confirm configurable V1 tax engine | A tax hook shape affects transaction, service, invoice, owner statement, and export models. | Design `TaxRule`, `TaxRate`, `TaxCategory`, effective dates, and scoped tax configuration. Do not hard-code Moroccan tax rules. |
| P0-15 | Lock first 90-day MVP cut | Controls slice order, acceptance tests, and what "build first" means. | Draft blueprints for the full specified system and call out `reservation -> tasks -> field app -> owner ledger` as checklist-suggested but not approved. |
| P0-16 | Lock V1 languages | Affects i18n, document generation, staff UX, owner portal, Guest Hub, and public site. | Design French + English with Arabic/RTL architecture-ready support, matching the Master Specification. |
| P0-17 | Lock currency approach | Affects every money field, ledger, reconciliation, report, and export. | Design MAD as primary while avoiding single-currency assumptions. |
| P0-18 | Lock V1 payment methods | Affects `PaymentProvider`, cash custody, settlement imports, reconciliation, and ledgers. | Design for Airbnb settlement, cash, PayPal, bank transfer, manual, and future provider extension without making Stripe a V1 dependency. |
| P0-19 | Choose first property templates | Needed for property onboarding defaults and for Phase 1 paper testing against Villa 405 and Villa Sultan. | Design template inheritance and property overrides; do not invent actual Villa 405 or Villa Sultan defaults. |
| P0-20 | Define V1 success metrics | Affects KPI priority, Command Center acceptance, and MVP proof. | Use the KPI categories from the Master Specification; do not invent target values. |
| P0-21 | Confirm application stack | Blocks repository setup, framework choices, UI conventions, validation, testing, and charts. | Use the Master Specification stack as the design target: Next.js, React, TypeScript, Tailwind, shadcn/ui, Radix, Lucide, PostgreSQL, Prisma, Zod, React Hook Form, TanStack Table/Query, Recharts or equivalent, Vitest, Playwright. |
| P0-22 | Confirm managed services | Blocks production/staging service setup and operational ownership. | Design provider boundaries for Vercel, managed PostgreSQL, Cloudflare R2, Resend, Inngest, Sentry, and Auth.js/mature auth. |
| P0-23 | Confirm Documenso deployment and maintainer | Blocks actual signature deployment and security ownership. | Design `SignatureProvider`, ALVILLAS-owned PDF generation, signed PDF archive, and Documenso as the source-supported V1 provider, pending legal/certificate confirmation. |
| P0-24 | Confirm provider abstractions | Blocks clean implementation boundaries. | Treat `StorageProvider`, `EmailProvider`, `SignatureProvider`, `PaymentProvider`, and reservation adapters as mandatory architectural boundaries in the blueprint drafts. |
| P0-25 | Set monthly V1 infrastructure cost ceiling | Blocks paid tiers, deployment sizing, and service selection tradeoffs. | Keep designs lean and provider-abstracted; do not choose paid tiers or claim budget approval. |

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

## Proposed Implementation Assumptions, Not Approvals

- The blueprints can use the Master Specification and Technology & Architecture Decisions v1.1 as design defaults.
- Financial models can define configurable hooks, immutable movements, ownership vs custody, and reconciliation patterns, but must not encode unapproved legal/tax treatment.
- Guest ID/document entities can be modeled with restricted access and retention hooks, but exact retention and storage behavior remains blocked by legal/privacy decisions.
- Agreement/document entities can be modeled with versions and signature abstractions, but final contract wording and signature assurance remain blocked.
- The P0-14 iCal decision is approved; richer OTA APIs and WhatsApp Business API remain future extension points, not V1 build requirements.

## Gate Result

- Phase 0 exit gate: not passed. Phase 0 still has unresolved legal, accounting, product, and technology decisions.
- Phase 1 documents: can be drafted from approved sources in this commit, but Phase 1 should not be marked complete until the three blueprints are reviewed and tested on paper against real Villa 405 and Villa Sultan data.
- Application code: must not start until Phase 0 approval and the three Phase 1 blueprints are complete.

## Acceptance Criteria For This Prerequisite Review

- P0-14 is recorded as DECIDED/DONE with evidence and date.
- Remaining blockers are separated into architecture/coding blockers and later production/compliance blockers.
- Proposed assumptions are explicitly labeled as assumptions, not approvals.
- No legal advice, accountant approval, tax rule, compliance clearance, provider pricing, test result, deployment success, or owner approval is fabricated.
