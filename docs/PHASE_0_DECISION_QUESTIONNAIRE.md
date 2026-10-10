# ALVILLAS OS Phase 0 Decision Questionnaire

This questionnaire consolidates every unanswered Phase 0 decision from `docs/PHASE_0_DECISION_REGISTER.md`. It is grouped by decision owner so business decisions, legal advice, accounting advice, and technical confirmations remain separate.

P0-13 is excluded because the business owner approved it on 2026-10-09. Technical verification for clean-room compliance remains a separate implementation/compliance requirement.

P0-14 is excluded because the business owner approved the V1 iCal-first decision on 2026-10-09: iCal-first scheduled calendar synchronization, ALVILLAS-owned reservation normalization, duplicate/conflict detection, sync monitoring and failure handling, Airbnb settlement CSV/import as a separate financial source, manual WhatsApp plus generated Guest Hub links, no internal messaging system, no PMS or channel-manager purchase/integration/research in V1, and extensible adapters for future needs.

No answer should be treated as a legal or accounting conclusion unless it comes from the qualified professional owner listed for that question.

## Business/Product Owner

1. P0-01 / Decision Register P0-01: Can you provide or record evidence that ALVILLAS SARL is fully incorporated and registered, including commercial register, tax IDs, social security, and company bank accounts?
   - Source-supported answer format: confirmed with evidence; not confirmed; blocked by missing evidence.
   - Consequence if unresolved: Phase 0 legal/compliance exit gate remains blocked.

2. P0-15 / Decision Register P0-15: What is the approved first 90-day MVP cut?
   - Source-supported options: checklist-suggested `reservation -> tasks -> field app -> owner ledger`; include property onboarding first as implied by the Master Specification slice sequence; explicitly define another owner-approved cut.
   - Consequence if unresolved: Phase 1 blueprint priority, sprint planning, and MVP acceptance tests remain ambiguous.

3. P0-16 / Decision Register P0-16: Do you approve V1 as French + English, with Arabic architecture-ready / RTL support?
   - Source-supported options: French + English at minimum; Arabic architecture-ready.
   - Consequence if unresolved: i18n architecture, generated documents/emails, public website language scope, and field-app language scope cannot be locked.

4. P0-17 / Decision Register P0-17: Do you approve MAD as the primary currency while requiring the data model to avoid single-currency assumptions?
   - Source-supported options: MAD primary; no single-currency assumptions.
   - Consequence if unresolved: transaction, ledger, report, payment, and export models cannot be safely designed.

5. P0-18 / Decision Register P0-18: Which V1 payment methods are approved?
   - Source-supported options: Airbnb settlement; cash; PayPal; bank transfer; manual; future provider; Stripe deferred unless direct-booking strategy requires it.
   - Consequence if unresolved: PaymentProvider scope, cash custody, Airbnb settlement reconciliation, and owner ledger design remain blocked.

6. P0-19 / Decision Register P0-19: Which first property templates should be created from Villa 405 and Villa Sultan?
   - Source-supported options: Villa 405-based template; Villa Sultan-based template; standard property template plus overrides; custom setup.
   - Consequence if unresolved: onboarding defaults, inventory templates, service availability, workflows, and Phase 1 testing with real villa data remain blocked.

7. P0-20 / Decision Register P0-20: What measurable V1 success metrics prove the north star, "run tomorrow's operation in minutes, not hours"?
   - Source-supported options: choose targets from KPI categories such as turnaround time, staff productivity, variance rate, cash position, occupancy, ADR, RevPAR, owner net, service margin, expense per stay, laundry cost, and inventory consumption.
   - Consequence if unresolved: MVP success, Command Center priorities, report priorities, and Golden Path acceptance remain subjective.

8. P0-25 / Decision Register P0-25: What numeric monthly infrastructure cost ceiling is approved for V1?
   - Source-supported options: no numeric options are specified; source philosophy is low recurring cost, paid reliability where it matters, open source where it avoids operational complexity, and no expensive enterprise tools initially.
   - Consequence if unresolved: service tier choices, Documenso deployment mode, monitoring/email/job/storage budgets, and production readiness budget cannot be approved.

## Lawyer

1. P0-02 / Decision Register P0-02: Please advise and approve how owner money held by ALVILLAS should be legally framed.
   - Source-supported options to evaluate: management mandate; separate bank account for owner funds; any lawyer-required alternative or restriction.
   - Consequence if unresolved: owner-money handling, owner ledger, owner portal money views, payouts, and reconciliation remain blocked.

2. P0-03 / Decision Register P0-03: Please review and approve the final owner management agreement structure and wording.
   - Source-supported requirements: FR/EN, Arabic-ready, immutable versioning, ALVILLAS-generated PDFs, signature workflow through the selected signature provider.
   - Consequence if unresolved: owner onboarding package, agreement signing, document templates, and Golden Path agreement steps remain blocked.

3. P0-04 / Decision Register P0-04: Please review and approve the final guest agreement and house rules.
   - Source-supported requirements: FR/EN/AR guest agreement and house rules; signing through the signature provider where required.
   - Consequence if unresolved: Guest Hub signing and house-rule acceptance cannot be completed.

4. P0-05 / Decision Register P0-05: Please advise ALVILLAS's data-protection obligations for guest data and ID documents under Law 09-08 / CNDP, including whether any declaration is required.
   - Source-supported answer format: obligations; required declarations; approved handling rules; unresolved legal blocker if advice cannot yet be given.
   - Consequence if unresolved: guest profile/forms, guest ID storage, permissions, signed URLs, and retention behavior remain blocked.

5. P0-06 / Decision Register P0-06: Please advise guest registration obligations and the rules for storing guest ID documents.
   - Source-supported answer format: required registration data/documents; storage limits; access limits; retention/deletion requirements.
   - Consequence if unresolved: Guest Hub compliance flows and ID document storage cannot be designed safely.

6. P0-07 / Decision Register P0-07: Please advise what signature level Moroccan contracts require and whether Documenso is acceptable for each contract type.
   - Source-supported options to evaluate: Documenso as V1 provider; self-signed certificate; CA-issued certificate; qualified trust-service option; different provider if legally required.
   - Consequence if unresolved: SignatureProvider implementation, Documenso certificate/security plan, owner/guest signing, and signed PDF archive remain blocked.

7. P0-08 / Decision Register P0-08: Please review and approve the data retention policy and privacy/legal compliance policy.
   - Source-supported requirements: retention policy, privacy/legal compliance policy, sensitive document controls, signed URLs, encrypted sensitive data where appropriate.
   - Consequence if unresolved: document storage, guest ID retention, backups, deletion/archival behavior, and production launch readiness remain blocked.

## Accountant

1. P0-09 / Decision Register P0-09: Please advise and approve VAT, commission invoicing, tourist tax, and owner-statement treatment.
   - Source-supported answer format: approved treatment, configurable tax requirements, required categories/rates/effective dates, and examples.
   - Consequence if unresolved: financial engine configuration, invoices, owner statements, tax hooks, and monthly close remain blocked.

2. P0-10 / Decision Register P0-10: Which accountant export formats and report contents are required?
   - Source-supported options: CSV; Excel; PDF; accountant-friendly transaction exports; income; expenses; owner statements; bank reconciliation; supplier payments; staff payments.
   - Consequence if unresolved: export contracts, reporting templates, and accounting handoff cannot be designed.

3. P0-11 / Decision Register P0-11: Does the proposed configurable tax model cover the accounting/tax setup you need for V1?
   - Source-supported options: `TaxRule`, `TaxRate`, `TaxCategory`, effective dates, property, service, transaction type; no hard-coded Moroccan tax logic.
   - Consequence if unresolved: tax schema and configuration hooks cannot be accepted.

4. P0-12 / Decision Register P0-12: What monthly closing and locking rules should ALVILLAS OS enforce?
   - Source-supported answer format: close calendar, lock behavior, allowed post-close adjustments, void/adjustment rules, reopening policy, and required reports.
   - Consequence if unresolved: ledger finalization, owner statements, accounting exports, variance resolution, and monthly close workflows remain blocked.

## Technical Owner

1. P0-11 / Decision Register P0-11: Can you confirm V1 will implement tax as configurable rules/rates/categories/effective dates and will not hard-code Moroccan tax logic?
   - Source-supported options: configurable tax hooks; no hard-coded Moroccan tax logic; accountant-owned actual configuration.
   - Consequence if unresolved: Phase 2/Phase 7 financial architecture cannot be approved.

2. P0-21 / Decision Register P0-21: Do you confirm the V1 application stack?
   - Source-supported options: Next.js, React, TypeScript, Tailwind, shadcn/ui, Radix, Lucide, PostgreSQL, Prisma, Zod, React Hook Form, TanStack Table/Query, Recharts or lightweight equivalent, Vitest, Playwright.
   - Consequence if unresolved: Phase 2 repository setup, component conventions, database access, validation, forms, tables, charts, and testing cannot start cleanly.

3. P0-22 / Decision Register P0-22: Do you confirm the V1 managed services and service ownership?
   - Source-supported options: Vercel, managed PostgreSQL, Cloudflare R2, Resend, Inngest, Sentry, Auth.js/mature auth, provider-agnostic database layer.
   - Consequence if unresolved: deployment, storage, email, jobs, monitoring, auth, backups, and cost planning remain blocked.

4. P0-23 / Decision Register P0-23: What Documenso deployment mode and maintenance owner are approved, assuming legal advice permits Documenso?
   - Source-supported options: self-hosted Documenso initially; hosted Documenso if approved; alternative provider only if required by legal/accounting advice; ALVILLAS owns PDF generation; Documenso owns signature workflow.
   - Consequence if unresolved: SignatureProvider implementation, document signing, signed PDF archive, certificate/security plan, and operational maintenance remain blocked.

5. P0-24 / Decision Register P0-24: Do you confirm provider abstractions as mandatory V1 architectural boundaries?
   - Source-supported options: `StorageProvider`, `EmailProvider`, `SignatureProvider`, `PaymentProvider`, reservation adapters including `ICalAdapter`, `AirbnbAdapter`, `BookingComAdapter`, `VrboAdapter`, `DirectBookingAdapter`, and `CSVAdapter`.
   - Consequence if unresolved: provider SDK usage may leak into business logic and make future service/provider changes more expensive.

6. P0-25 / Decision Register P0-25: What is the estimated V1 monthly cost for the proposed stack under the business owner's cost ceiling?
   - Source-supported inputs: lean architecture; pay for reliability; avoid expensive enterprise tools; Vercel, managed PostgreSQL, R2, Resend, Inngest, Sentry, Documenso deployment, Auth.js/mature auth.
   - Consequence if unresolved: the business owner cannot approve the monthly infrastructure ceiling or service tiers.
