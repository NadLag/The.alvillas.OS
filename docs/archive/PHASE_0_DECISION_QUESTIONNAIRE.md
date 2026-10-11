# ALVILLAS OS Phase 0 Decision Questionnaire

This questionnaire consolidates every unanswered Phase 0 decision from `docs/PHASE_0_DECISION_REGISTER.md`. It is grouped by decision owner so business decisions, legal advice, accounting advice, and technical confirmations remain separate.

P0-13 is excluded because the business owner approved it on 2026-10-09. Technical verification for clean-room compliance remains a separate implementation/compliance requirement.

P0-14 is excluded because the business owner approved the V1 iCal-first decision on 2026-10-09: iCal-first scheduled calendar synchronization, ALVILLAS-owned reservation normalization, duplicate/conflict detection, sync monitoring and failure handling, Airbnb settlement CSV/import as a separate financial source, manual WhatsApp plus generated Guest Hub links, no internal messaging system, no PMS or channel-manager purchase/integration/research in V1, and extensible adapters for future needs.

P0-15, P0-19, P0-20, and P0-25 are excluded because the business owner approved them in Prompt 009 on 2026-10-10.

P0-11, P0-16, P0-17, P0-18, P0-21, P0-22, and P0-24 are excluded because the Prompt 009 review recorded them as decided from the locked Master Specification and embedded Technology & Architecture Decisions v1.1. These exclusions do not claim legal, tax, accounting, deployment, or paid-service approval.

P0-23 is partially answered: the owner prefers self-hosted Documenso, subject to Moroccan legal validation. It remains listed where legal/security/maintenance evidence is still required.

No answer should be treated as a legal or accounting conclusion unless it comes from the qualified professional owner listed for that question.

## Business/Product Owner

1. P0-01 / Decision Register P0-01: Can you provide or record evidence that ALVILLAS SARL is fully incorporated and registered, including commercial register, tax IDs, social security, and company bank accounts?
   - Source-supported answer format: confirmed with evidence; not confirmed; blocked by missing evidence.
   - Consequence if unresolved: Phase 0 legal/compliance exit gate remains blocked.

Resolved business/product decisions should not be re-asked. Their implementation details belong in the relevant phase work:

- P0-15: complete production-ready scope across all 17 phases; no MVP reduction.
- P0-16: French and English in V1; Arabic/RTL architecture-ready.
- P0-17: MAD primary with multicurrency-capable money models.
- P0-18: Airbnb settlement, cash, PayPal, bank transfer, and manual payments in V1; no Stripe dependency for V1.
- P0-19: separate initial configurable templates for Villa 405 and Sultan's House.
- P0-20: every Master Specification KPI with configurable targets.
- P0-25: no fixed monthly infrastructure cost ceiling; expenses approved case by case.

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
   - Source-supported options to evaluate: owner-preferred self-hosted Documenso as V1 provider; self-signed certificate; CA-issued certificate; qualified trust-service option; different provider if legally required.
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

1. P0-23 / Decision Register P0-23: What Documenso maintenance owner, security owner, certificate/trust plan, backup/update plan, and deployment-readiness checklist are approved, assuming legal advice permits Documenso?
   - Source-supported options: self-hosted Documenso initially; hosted Documenso if approved; alternative provider only if required by legal/accounting advice; ALVILLAS owns PDF generation; Documenso owns signature workflow.
   - Consequence if unresolved: SignatureProvider implementation, document signing, signed PDF archive, certificate/security plan, and operational maintenance remain blocked.

Resolved technical confirmations should not be re-asked:

- P0-11: configurable V1 tax hooks, with accountant-owned actual tax setup.
- P0-21: application stack from Master Specification section 73 and Technology & Architecture Decisions v1.1.
- P0-22: managed service architecture from Technology & Architecture Decisions v1.1; paid tiers and purchases remain case-by-case approvals.
- P0-24: provider abstractions and integration adapters are mandatory.
- P0-25: no fixed ceiling; maintain `docs/INFRASTRUCTURE_COST_REGISTER.md` and get owner approval before paid commitments.
