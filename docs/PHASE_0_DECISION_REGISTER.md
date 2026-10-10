# ALVILLAS OS Phase 0 Decision Register

This register is a decision-preparation artifact for the clean ALVILLAS OS rebuild. It does not mark Phase 0 complete and does not modify the locked source documents.

Authoritative sources reviewed:

- `docs/ALVILLAS_OS_Master_Specification.docx`
- `docs/ALVILLAS_OS_Build_Checklist.docx`
- `docs/CHECKLIST_STATE.md`

Status values used here: `OPEN`, `PROPOSED`, `AWAITING_EXTERNAL_ADVICE`, `DECIDED`, `BLOCKED`.

Only P0-13 is marked `DECIDED`, based on explicit business-owner approval recorded on October 9, 2026. All other Phase 0 items remain undecided.

## Phase 0 Exit Gate

Phase 0 is not complete until all of the following are true:

- Every required Phase 0 decision from P0-01 through P0-25 has a named owner, an explicit outcome, supporting evidence, and a real decision date.
- Required business-owner decisions have recorded outcomes and are not left as suggestions.
- Legal and compliance red-zone items have qualified legal advice or are explicitly recorded as unresolved blockers.
- Accounting and tax items have qualified accountant input where required.
- Required technical choices are confirmed or explicitly blocked.
- Every closed decision has evidence traceable to source documents, professional advice, owner approval, or a recorded technical decision.
- No Phase 1 or later implementation gate is treated as passed before its required evidence exists.

Current exit-gate result: `BLOCKED` for completion, because Phase 0 still has unresolved decisions and the Phase 0 checklist exit test remains TODO.

## Source Gaps And Ambiguities

- P0-13, ALVILLAS-only clean-room boundary: the active checklist now requires ALVILLAS OS to be independent from Orbix, HostNow, and legacy projects. The Master Specification describes ALVILLAS OS as the private operating system for ALVILLAS SARL and does not define any dependency on those projects.
- P0-14, build-vs-buy for calendar sync and guest messaging: the Build Checklist requires a build-vs-buy check, while the Master Specification only states iCal-first reservation integration, adapter architecture, WhatsApp as the human channel, generated links initially, and API later if justified.
- P0-15, first 90-day MVP: the Build Checklist suggests `reservation -> tasks -> field app -> owner ledger`, while the Master Specification development strategy starts with Slice 1 property onboarding before reservations, field app, and financial engine. This is a sequencing ambiguity, not enough evidence for an approved MVP boundary.
- P0-23, signature approach: Technology Decisions v1.1 says Documenso is the selected V1 signature provider and recommends self-hosted Documenso initially, but Phase 0 still requires confirmation of self-hosted vs hosted operation and a maintainer. Legal signature level and certificate requirements also remain unresolved.
- P0-25, monthly V1 infrastructure cost ceiling: Technology Decisions v1.1 supports a low-recurring-cost philosophy and lists lean services, but no numeric monthly ceiling is specified.

## Decision Register

### P0-01 - ALVILLAS SARL incorporation and registration

- Requirement/question: Confirm ALVILLAS SARL is fully incorporated and registered, including commercial register, tax IDs, social security, and company bank accounts.
- Sources: Build Checklist Phase 0 legal and compliance; `CHECKLIST_STATE.md` P0-01; Master Specification section 84 legal red-zone context.
- Current status: `OPEN`
- Decision owner: business owner
- Source-supported options: no alternative operating options are provided; the source requires confirmation of registration evidence.
- Recommendation: none; this is an evidence gate.
- Evidence or approval required: official registration, tax, social security, and company bank account evidence, plus recorded owner confirmation.
- Date decided:
- Dependencies and implementation gates: blocks Phase 0 exit and any production legal/financial operation that assumes ALVILLAS SARL is fully registered.

### P0-02 - Legal frame for owner money held by ALVILLAS

- Requirement/question: Decide how owner money held by ALVILLAS is legally framed and validate the answer with a lawyer.
- Sources: Build Checklist Phase 0 legal and compliance; `CHECKLIST_STATE.md` P0-02; Master Specification sections 27, 29, 34, 56, 58, 84; Technology Decisions v1.1 sections 8, 11, 12, 30.
- Current status: `AWAITING_EXTERNAL_ADVICE`
- Decision owner: lawyer
- Source-supported options: management mandate; separate bank account for owner funds. The system must also distinguish money ownership from physical money location.
- Recommendation: none; requires qualified legal advice.
- Evidence or approval required: written lawyer advice approving the legal frame and any required banking/custody structure.
- Date decided:
- Dependencies and implementation gates: blocks owner ledger, owner portal money views, payout rules, reconciliation, and any handling of owner funds.

### P0-03 - Final owner management agreement

- Requirement/question: Write the final owner management agreement in French and English, Arabic-ready, and have it reviewed by a lawyer.
- Sources: Build Checklist Phase 0 legal and compliance; `CHECKLIST_STATE.md` P0-03; Master Specification sections 5, 6, 7, 19, 56, 60, 84; Technology Decisions v1.1 sections 19, 20.
- Current status: `AWAITING_EXTERNAL_ADVICE`
- Decision owner: lawyer
- Source-supported options: FR/EN agreement with Arabic-ready structure; immutable versioned documents; ALVILLAS-owned PDF generation; signature workflow through the signature provider.
- Recommendation: none; contract wording requires legal review.
- Evidence or approval required: final lawyer-reviewed agreement templates, language/versioning requirements, and approval record.
- Date decided:
- Dependencies and implementation gates: blocks owner onboarding package, agreement signing, document templates, owner approvals, and the Golden Path agreement step.

### P0-04 - Final guest agreement and house rules

- Requirement/question: Write the final guest agreement and house rules in FR/EN/AR.
- Sources: Build Checklist Phase 0 legal and compliance; `CHECKLIST_STATE.md` P0-04; Master Specification sections 37, 60, 84; Phase 8 checklist guest agreement and house-rules requirements.
- Current status: `AWAITING_EXTERNAL_ADVICE`
- Decision owner: lawyer
- Source-supported options: FR/EN/AR guest agreement and house rules; signing through the signature provider where required.
- Recommendation: none; legal wording requires qualified review.
- Evidence or approval required: final reviewed agreement and house-rule templates, language coverage, and approval record.
- Date decided:
- Dependencies and implementation gates: blocks Guest Hub signing, house-rule acceptance, guest document archive, and guest-facing legal flows.

### P0-05 - Data-protection obligations for guest data and ID documents

- Requirement/question: Check data-protection obligations for guest data and ID documents under Law 09-08 / CNDP and complete any required declaration.
- Sources: Build Checklist Phase 0 legal and compliance; `CHECKLIST_STATE.md` P0-05; Master Specification sections 37, 60, 78, 84; Phase 8 checklist guest ID handling.
- Current status: `AWAITING_EXTERNAL_ADVICE`
- Decision owner: lawyer
- Source-supported options: no implementation option is approved yet; the source requires determining obligations and completing any required declaration.
- Recommendation: none; requires qualified legal/privacy advice.
- Evidence or approval required: written legal/privacy advice, CNDP declaration evidence if required, and approved handling requirements for guest data and ID documents.
- Date decided:
- Dependencies and implementation gates: blocks Guest Hub profile/forms, guest ID storage, document retention, permissions, and signed URL rules.

### P0-06 - Guest registration obligations and ID storage rules

- Requirement/question: Check guest registration obligations and rules for storing guest ID documents.
- Sources: Build Checklist Phase 0 legal and compliance; `CHECKLIST_STATE.md` P0-06; Master Specification sections 37, 60, 78, 84; Phase 8 checklist guest ID handling.
- Current status: `AWAITING_EXTERNAL_ADVICE`
- Decision owner: lawyer
- Source-supported options: no options are specified; the source requires legal confirmation of registration and storage rules.
- Recommendation: none; requires qualified legal advice.
- Evidence or approval required: written legal advice describing guest registration duties, required fields/documents, storage limits, retention, access, and deletion/archival rules.
- Date decided:
- Dependencies and implementation gates: blocks guest registration forms, ID document storage, retention policy, and Guest Hub compliance flows.

### P0-07 - Moroccan contract signature level and e-signature provider choice

- Requirement/question: Decide which signature level Moroccan contracts need and confirm the e-signature provider choice.
- Sources: Build Checklist Phase 0 legal and compliance; `CHECKLIST_STATE.md` P0-07; Master Specification section 84; Technology Decisions v1.1 section 7 and sections 19-20.
- Current status: `AWAITING_EXTERNAL_ADVICE`
- Decision owner: lawyer
- Source-supported options: Documenso as V1 provider behind `SignatureProvider`; later replacement with an appropriate provider if lawyer/accountant requires a legally recognized signature level; self-signed certificate, CA-issued certificate, or qualified trust-service option depending on required assurance.
- Recommendation: PROPOSED — NOT APPROVED: keep Documenso as the V1 `SignatureProvider` unless legal advice requires a different legally recognized signature provider or certificate level.
- Evidence or approval required: lawyer advice on Moroccan contract signature level, certificate/trust requirements, and approval or rejection of Documenso for each contract type.
- Date decided:
- Dependencies and implementation gates: blocks SignatureProvider implementation details, owner/guest signing flows, signed PDF archive, and Documenso deployment decision P0-23.

### P0-08 - Data retention and privacy/legal compliance policy

- Requirement/question: Write the data retention policy and privacy/legal compliance policy.
- Sources: Build Checklist Phase 0 legal and compliance; `CHECKLIST_STATE.md` P0-08; Master Specification sections 60, 78, 84.
- Current status: `AWAITING_EXTERNAL_ADVICE`
- Decision owner: lawyer
- Source-supported options: no alternatives are specified; the source requires final policies.
- Recommendation: none; requires legal/privacy policy drafting and approval.
- Evidence or approval required: approved retention schedule, privacy/legal compliance policy, and any CNDP or guest-ID related requirements from P0-05 and P0-06.
- Date decided:
- Dependencies and implementation gates: blocks document storage, signed URLs, guest ID retention, backups, deletion/archival behavior, and production launch readiness.

### P0-09 - VAT, commission invoicing, tourist tax, and owner-statement treatment

- Requirement/question: Meet the accountant and agree VAT, commission invoicing, tourist tax, and owner-statement treatment.
- Sources: Build Checklist Phase 0 accounting and tax; `CHECKLIST_STATE.md` P0-09; Master Specification sections 14, 15, 50-55, 62, 84; Technology Decisions v1.1 sections 14-15.
- Current status: `AWAITING_EXTERNAL_ADVICE`
- Decision owner: accountant
- Source-supported options: no tax treatment is approved in the sources; Technology Decisions v1.1 requires configurable tax architecture with actual Moroccan accounting/tax configuration by the accountant.
- Recommendation: none; requires qualified accounting/tax advice.
- Evidence or approval required: accountant-approved treatment for VAT, commission invoicing, tourist tax, owner statements, and any required tax categories/rates/effective dates.
- Date decided:
- Dependencies and implementation gates: blocks financial engine configuration, invoices, owner statements, tax hooks, reports, and monthly close.

### P0-10 - Accountant export formats

- Requirement/question: Agree the export formats the accountant needs.
- Sources: Build Checklist Phase 0 accounting and tax; `CHECKLIST_STATE.md` P0-10; Master Specification section 84; Technology Decisions v1.1 section 15; Phase 7 checklist integrity, tax, and exports.
- Current status: `AWAITING_EXTERNAL_ADVICE`
- Decision owner: accountant
- Source-supported options: CSV, Excel, PDF, accountant-friendly transaction exports, income, expenses, owner statements, bank reconciliation, supplier payments, staff payments.
- Recommendation: PROPOSED — NOT APPROVED: support CSV, Excel, PDF, and accountant-friendly transaction exports first, with direct accounting software integration deferred until worthwhile.
- Evidence or approval required: accountant-approved export list, field definitions, date ranges, grouping rules, and sample output acceptance.
- Date decided:
- Dependencies and implementation gates: blocks export contracts, report templates, accounting handoff, and monthly close.

### P0-11 - Configurable V1 tax engine

- Requirement/question: Confirm tax stays configurable in V1 and is not hard-coded.
- Sources: Build Checklist Phase 0 accounting and tax; `CHECKLIST_STATE.md` P0-11; Master Specification sections 76, 83, 84; Technology Decisions v1.1 section 14.
- Current status: `PROPOSED`
- Decision owner: technical owner
- Source-supported options: `TaxRule`, `TaxRate`, `TaxCategory`, effective dates, property, service, and transaction type; no hard-coded Moroccan tax logic in V1.
- Recommendation: PROPOSED — NOT APPROVED: implement configurable tax hooks in V1 and leave actual Moroccan tax configuration to accountant-approved setup.
- Evidence or approval required: technical confirmation in architecture notes plus accountant agreement that the configurable model covers required tax treatment.
- Date decided:
- Dependencies and implementation gates: blocks financial engine schema/configuration, service tax rules, owner statements, accountant exports, and production accounting setup.

### P0-12 - Monthly closing and locking rules

- Requirement/question: Agree monthly closing and locking rules.
- Sources: Build Checklist Phase 0 accounting and tax; `CHECKLIST_STATE.md` P0-12; Master Specification sections 50-55, 62, 84; Phase 7 checklist monthly closing and locking.
- Current status: `AWAITING_EXTERNAL_ADVICE`
- Decision owner: accountant
- Source-supported options: no specific lock policy is approved; sources require monthly closing and locking while preserving auditability, adjustments, and no silent edits.
- Recommendation: none; requires accountant-approved close rules.
- Evidence or approval required: accountant-approved close calendar, lock behavior, allowed post-close adjustments, void/adjustment rules, and reporting requirements.
- Date decided:
- Dependencies and implementation gates: blocks ledger finalization, owner statements, accounting exports, variance resolution, and monthly close workflows.

### P0-13 - ALVILLAS-only clean-room product boundary

- Requirement/question: Confirm ALVILLAS OS is an independent, clean-room product with its own repository, architecture, database, configuration, integrations, and deployment. No source-code sharing or dependencies on Orbix, HostNow, or legacy projects.
- Sources: Build Checklist Phase 0 product decisions; `CHECKLIST_STATE.md` P0-13; Master Specification sections 0, 2, 73, and 84.
- Current status: `DECIDED`
- Decision owner: Business owner
- Approved outcome: Independent, clean-room ALVILLAS OS
- Source-supported options: confirm independent clean-room product boundary; record a blocker if any dependency on Orbix, HostNow, or a legacy project exists.
- Recommendation: APPROVED for owner decision only: ALVILLAS OS is independent and clean-room.
- Evidence: Explicit business-owner approval recorded in this ChatGPT conversation on October 9, 2026.
- Decision date: `2026-10-09`
- Technical verification: Still required as a separate implementation/compliance requirement; no technical verification is claimed completed by this approval record.
- Dependencies and implementation gates: blocks repository/module boundaries, architecture baselines, database/configuration design, integrations, deployment, and any Phase 1+ implementation that could inherit legacy code or architecture.

### P0-14 - Build-vs-buy for calendar sync and guest messaging

- Requirement/question: Run a build-vs-buy check on calendar sync and guest messaging against buying a channel manager / PMS.
- Sources: Build Checklist Phase 0 product decisions; `CHECKLIST_STATE.md` P0-14; Master Specification sections 37-38; Technology Decisions v1.1 sections 6, 9, 21.
- Current status: `OPEN`
- Decision owner: technical owner
- Source-supported options: build iCal-first reservation sync with adapters; add OTA APIs later; use manual WhatsApp plus generated links initially; use WhatsApp Business API/provider later if volume justifies it; buy channel manager / PMS instead of building where justified.
- Recommendation: PROPOSED — NOT APPROVED: keep iCal-first and adapter-based architecture as the default technical direction while completing the required build-vs-buy analysis before implementation.
- Evidence or approval required: build-vs-buy analysis, selected vendor or build decision, cost/operations comparison, integration risks, and business approval.
- Date decided:
- Dependencies and implementation gates: blocks reservation adapter scope, guest messaging design, background job requirements, and potential PMS/channel-manager integration work.

### P0-15 - First 90-day MVP cut

- Requirement/question: Lock the first 90-day MVP cut.
- Sources: Build Checklist Phase 0 product decisions; `CHECKLIST_STATE.md` P0-15; Master Specification section 80 development strategy; Build Checklist phases 4-7.
- Current status: `PROPOSED`
- Decision owner: business owner
- Source-supported options: suggested checklist cut is `reservation -> tasks -> field app -> owner ledger`; Master Specification slice sequence starts with property onboarding, then reservations, field app, and financial engine.
- Recommendation: PROPOSED — NOT APPROVED: use the checklist's suggested MVP cut only after resolving whether property onboarding is included in the first 90 days or treated as prerequisite setup.
- Evidence or approval required: business-approved MVP scope, explicit inclusions/exclusions, success criteria, and any deferred Phase 4 onboarding work.
- Date decided:
- Dependencies and implementation gates: blocks sprint planning, Phase 1 blueprint prioritization, slice ordering, and acceptance tests.

### P0-16 - V1 languages

- Requirement/question: Lock V1 languages.
- Sources: Build Checklist Phase 0 product decisions; `CHECKLIST_STATE.md` P0-16; Master Specification baseline status and section 6; Phase 2 and Phase 13 checklist i18n items.
- Current status: `PROPOSED`
- Decision owner: business owner
- Source-supported options: French and English at minimum for V1; Arabic architecture-ready with RTL support.
- Recommendation: PROPOSED — NOT APPROVED: V1 ships French + English, with Arabic architecture-ready / RTL structure but not necessarily full Arabic content unless separately approved.
- Evidence or approval required: business approval of V1 language scope, owner/guest/staff language expectations, and RTL readiness requirement.
- Date decided:
- Dependencies and implementation gates: blocks i18n architecture, content scope, document/email generation, field app labels, and public website language scope.

### P0-17 - Currency approach

- Requirement/question: Lock currency approach.
- Sources: Build Checklist Phase 0 product decisions; `CHECKLIST_STATE.md` P0-17; Master Specification baseline status and section 79 scalability.
- Current status: `PROPOSED`
- Decision owner: business owner
- Source-supported options: MAD primary; no single-currency assumptions in the model.
- Recommendation: PROPOSED — NOT APPROVED: use MAD as the primary currency while designing all money models to avoid single-currency assumptions.
- Evidence or approval required: business/accounting approval of MAD primary currency, multi-currency data model requirements, rounding/display rules, and any exchange-rate policy if needed.
- Date decided:
- Dependencies and implementation gates: blocks transaction schema, ledger formulas, reports, payment adapters, owner statements, and exports.

### P0-18 - V1 payment methods

- Requirement/question: Lock V1 payment methods.
- Sources: Build Checklist Phase 0 product decisions; `CHECKLIST_STATE.md` P0-18; Master Specification sections 26-29, 53; Technology Decisions v1.1 sections 8-13 and 30.
- Current status: `PROPOSED`
- Decision owner: business owner
- Source-supported options: Airbnb settlement, cash, PayPal, bank transfer, manual; future provider; Stripe future only if direct-booking strategy requires it.
- Recommendation: PROPOSED — NOT APPROVED: support Airbnb settlement, cash, PayPal, bank transfer, and manual payments in V1 through `PaymentProvider` and provider adapters; do not make Stripe a V1 dependency.
- Evidence or approval required: business approval of V1 payment methods, accountant confirmation of recording/reconciliation needs, and technical confirmation of adapter boundaries.
- Date decided:
- Dependencies and implementation gates: blocks PaymentProvider design, cash custody, Airbnb settlement reconciliation, owner ledger, and payout/accounting exports.

### P0-19 - First property templates

- Requirement/question: Choose the first property templates based on Villa 405 and Villa Sultan.
- Sources: Build Checklist Phase 0 product decisions; `CHECKLIST_STATE.md` P0-19; Master Specification sections 5, 42; Phase 4 and Phase 9 checklist property/inventory template items.
- Current status: `OPEN`
- Decision owner: business owner
- Source-supported options: Villa 405-based template; Villa Sultan-based template; standard property template with property-specific overrides; custom setup.
- Recommendation: none; source requires choosing the first templates but does not define their contents.
- Evidence or approval required: approved starting templates, operating profiles, inventory/service/workflow defaults, and known overrides for Villa 405 and Villa Sultan.
- Date decided:
- Dependencies and implementation gates: blocks property onboarding wizard defaults, workflows, inventory templates, services, owner onboarding package, and Phase 1 real-data blueprint tests.

### P0-20 - V1 success metrics

- Requirement/question: Define success metrics tied to the north star, "run tomorrow's operation in minutes, not hours."
- Sources: Build Checklist Phase 0 product decisions; `CHECKLIST_STATE.md` P0-20; Master Specification section 1 north star and section 59 KPI architecture.
- Current status: `OPEN`
- Decision owner: business owner
- Source-supported options: metrics listed in the KPI architecture include occupancy, ADR, RevPAR, gross revenue, net revenue, OTA fees, commission, owner net, service revenue, service margin, expense per stay, laundry cost, inventory consumption, staff productivity, turnaround time, maintenance, variance rate, and cash position. No numeric targets are specified.
- Recommendation: none; source provides KPI categories but not measurable V1 targets.
- Evidence or approval required: measurable V1 success metrics, baselines, target values, measurement method, and acceptance criteria for the MVP and Golden Path.
- Date decided:
- Dependencies and implementation gates: blocks MVP acceptance, dashboard/report priority, Command Center criteria, and Phase 15 release validation.

### P0-21 - Application stack

- Requirement/question: Confirm the stack: Next.js, React, TypeScript, Tailwind, shadcn/ui, Radix, Lucide, PostgreSQL, Prisma, Zod, React Hook Form, TanStack Table/Query, Recharts.
- Sources: Build Checklist Phase 0 technology decisions; `CHECKLIST_STATE.md` P0-21; Master Specification section 73; Technology Decisions v1.1 sections 2, 27, 29, 30.
- Current status: `PROPOSED`
- Decision owner: technical owner
- Source-supported options: named stack above; Recharts or lightweight equivalent in Master Specification section 73; PostgreSQL + Prisma locked in Technology Decisions v1.1.
- Recommendation: PROPOSED — NOT APPROVED: confirm the listed stack, with Recharts as the V1 chart default unless a lightweight equivalent is explicitly approved.
- Evidence or approval required: technical approval record and any documented exceptions.
- Date decided:
- Dependencies and implementation gates: blocks Phase 2 foundation, repository setup, component conventions, database access, forms, validation, tables, charts, and tests.

### P0-22 - Hosting and managed services

- Requirement/question: Confirm services: Vercel, managed PostgreSQL, Cloudflare R2, Resend, Inngest, Sentry, Auth.js.
- Sources: Build Checklist Phase 0 technology decisions; `CHECKLIST_STATE.md` P0-22; Master Specification section 73; Technology Decisions v1.1 sections 3-6, 16, 24, 27, 29, 30.
- Current status: `PROPOSED`
- Decision owner: technical owner
- Source-supported options: Vercel for app hosting; managed PostgreSQL provider rather than self-maintained database server; Cloudflare R2 for object storage; Resend for email; Inngest for background jobs; Sentry for monitoring; Auth.js/mature auth. Provider-agnostic database layer should remain possible.
- Recommendation: PROPOSED — NOT APPROVED: confirm the listed services for V1 while keeping provider boundaries where v1.1 requires them.
- Evidence or approval required: technical approval, cost review against P0-25, selected managed PostgreSQL provider, service ownership, and any account/security requirements.
- Date decided:
- Dependencies and implementation gates: blocks Phase 2 deployment, storage, email, jobs, monitoring, auth, backups, and production readiness.

### P0-23 - Documenso deployment approach and maintainer

- Requirement/question: Confirm signature approach, Documenso self-hosted vs hosted, and who maintains it.
- Sources: Build Checklist Phase 0 technology decisions; `CHECKLIST_STATE.md` P0-23; Master Specification section 84; Technology Decisions v1.1 section 7 and sections 19-20.
- Current status: `AWAITING_EXTERNAL_ADVICE`
- Decision owner: technical owner
- Source-supported options: Documenso as selected V1 signature provider; self-hosted Documenso initially; hosted Documenso if approved; alternative provider only if required by legal/accounting advice; ALVILLAS owns PDF generation and Documenso owns signature workflow.
- Recommendation: PROPOSED — NOT APPROVED: keep Documenso as the V1 provider and decide only the deployment mode, certificate/trust level, security owner, and maintainer.
- Evidence or approval required: P0-07 legal advice, deployment-mode decision, maintainer assignment, security/certificate plan, cost estimate, backup/update plan, and acceptance of operational responsibility.
- Date decided:
- Dependencies and implementation gates: blocks SignatureProvider implementation, document signing, signed PDF archive, security ownership, and Documenso operating procedures.

### P0-24 - Provider abstractions

- Requirement/question: Confirm provider abstractions are mandatory.
- Sources: Build Checklist Phase 0 technology decisions; `CHECKLIST_STATE.md` P0-24; Master Specification sections 38, 73; Technology Decisions v1.1 sections 4-5, 7-9, 13, 29, 30.
- Current status: `PROPOSED`
- Decision owner: technical owner
- Source-supported options: `StorageProvider`, `EmailProvider`, `SignatureProvider`, `PaymentProvider`, and reservation adapters such as `ICalAdapter`, `AirbnbAdapter`, `BookingComAdapter`, `VrboAdapter`, `DirectBookingAdapter`, and `CSVAdapter`.
- Recommendation: PROPOSED — NOT APPROVED: make these provider interfaces and adapters mandatory architectural boundaries for V1.
- Evidence or approval required: technical approval in Phase 1 architecture, interface list, ownership, and code-review rule that business logic does not hard-code provider SDKs.
- Date decided:
- Dependencies and implementation gates: blocks Phase 2 provider interfaces, integration adapters, service replacement strategy, and financial/reservation/document architecture.

### P0-25 - Monthly V1 infrastructure cost ceiling

- Requirement/question: Set a monthly infrastructure cost ceiling for V1.
- Sources: Build Checklist Phase 0 technology decisions; `CHECKLIST_STATE.md` P0-25; Technology Decisions v1.1 sections 1, 3, 26, 27; identified gap: no numeric ceiling is specified in the sources.
- Current status: `OPEN`
- Decision owner: business owner
- Source-supported options: low recurring cost without sacrificing architecture/performance; pay for reliability where it matters; use open source where it saves money without operational complexity; avoid expensive enterprise tools initially; pay for Vercel, managed PostgreSQL, R2, Resend, Inngest, Sentry, self-hosted Documenso initially, and Auth.js/mature auth where justified.
- Recommendation: none; source supports cost philosophy but no amount.
- Evidence or approval required: numeric monthly V1 cost ceiling, service budget assumptions, free-tier/paid-tier policy, Documenso hosting cost assumption, and approval of tradeoffs if the selected stack exceeds the ceiling.
- Date decided:
- Dependencies and implementation gates: blocks managed-service selection, Documenso hosting choice, monitoring tier, email/job/storage sizing, and production budget approval.
