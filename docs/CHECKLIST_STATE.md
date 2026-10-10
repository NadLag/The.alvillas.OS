# CHECKLIST_STATE.md — ALVILLAS OS

Source of truth for build progress. Mirrors ALVILLAS_OS_Build_Checklist.docx (locked).

## Rules
- Status values only: `TODO`, `DONE`, `BLOCKED`, `DECISION NEEDED`. No "partial".
- `DONE` requires evidence: commit hash, test names with passing output, or screenshot/log reference.
- `BLOCKED` and `DECISION NEEDED` must state the exact reason and who must act.
- Do not delete, merge or reorder items. Update this file in the same commit as the work.
- Do not start a phase until the previous phase's "Done when" test is PASS.

## Phase summary
| Phase | Done-when test | Items done | Updated |
|---|---|---|---|
| Phase 0 — Decisions and prerequisites | TODO | 2 / 25 | 2026-10-09 |
| Phase 1 — Blueprint documents | TODO | 0 / 22 | |
| Phase 2 — Foundation | TODO | 0 / 23 | |
| Phase 3 — Identity, access and audit | TODO | 0 / 27 | |
| Phase 4 — Slice 1: Acquisition and property onboarding | TODO | 0 / 24 | |
| Phase 5 — Slice 2: Reservations to operations | TODO | 0 / 19 | |
| Phase 6 — Slice 3: Field app | TODO | 0 / 20 | |
| Phase 7 — Slice 4: Financial engine | TODO | 0 / 40 | |
| Phase 8 — Slice 5: Guest Hub, services and chef | TODO | 0 / 13 | |
| Phase 9 — Slice 6: Inventory, laundry, maintenance, assets and team | TODO | 0 / 17 | |
| Phase 10 — Slice 7: Owner portal | TODO | 0 / 9 | |
| Phase 11 — Slice 8: Command Center, reports and KPIs | TODO | 0 / 12 | |
| Phase 12 — Slice 9: Personal OS | TODO | 0 / 7 | |
| Phase 13 — Public website | TODO | 0 / 8 | |
| Phase 14 — Cross-cutting hardening | TODO | 0 / 22 | |
| Phase 15 — Master end-to-end test | TODO | 0 / 29 | |
| Phase 16 — Launch readiness and rollout | TODO | 0 / 18 | |

---

## Phase 0 — Decisions and prerequisites

**Done when:** Every item below has a named owner, a decision, and a date. Nothing in the red zone is left undecided.

**Phase test result:** TODO

### Legal and compliance (spec §84, red zone)

| ID | Item | Status | Evidence | Date |
|---|---|---|---|---|
| P0-01 | Confirm ALVILLAS SARL is fully incorporated and registered (commercial register, tax IDs, social security, company bank accounts) | TODO | | |
| P0-02 | Decide how owner money held by ALVILLAS is legally framed (management mandate, separate bank account for owner funds) and validate with a lawyer | TODO | | |
| P0-03 | Write the final owner management agreement (FR/EN, Arabic-ready), reviewed by a lawyer | TODO | | |
| P0-04 | Write the final guest agreement and house rules (FR/EN/AR) | TODO | | |
| P0-05 | Check data-protection obligations for guest data and ID documents (Law 09-08 / CNDP) and complete any required declaration | TODO | | |
| P0-06 | Check guest registration obligations and rules for storing guest ID documents | TODO | | |
| P0-07 | Decide which signature level Moroccan contracts need and confirm the e-signature provider choice | TODO | | |
| P0-08 | Write the data retention policy and privacy/legal compliance policy | TODO | | |

### Accounting and tax (spec §14, §15, §84)

| ID | Item | Status | Evidence | Date |
|---|---|---|---|---|
| P0-09 | Meet the accountant: agree VAT, commission invoicing, tourist tax and owner-statement treatment | TODO | | |
| P0-10 | Agree the export formats the accountant needs (CSV, Excel, PDF, transaction exports) | TODO | | |
| P0-11 | Confirm tax stays configurable in V1 (TaxRule, TaxRate, TaxCategory, effective dates) and is not hard-coded | TODO | | |
| P0-12 | Agree monthly closing and locking rules | TODO | | |

### Product decisions

| ID | Item | Status | Evidence | Date |
|---|---|---|---|---|
| P0-13 | Confirm ALVILLAS OS is an independent, clean-room product with its own repository, architecture, database, configuration, integrations, and deployment. No source-code sharing or dependencies on Orbix, HostNow, or legacy projects. | DONE | Approved decision: independent, clean-room ALVILLAS OS. Business-owner approval recorded in this ChatGPT conversation on 2026-10-09. Technical verification remains separate and is not claimed complete. | 2026-10-09 |
| P0-14 | Run a build-vs-buy check on calendar sync and guest messaging (channel manager / PMS) against building it | DONE | Approved decision: V1 uses iCal-first scheduled calendar synchronization, ALVILLAS-owned normalized reservation model, duplicate/conflict detection, sync monitoring/failure handling, Airbnb settlement CSV/import as separate financial data, manual WhatsApp plus generated Guest Hub links, no internal messaging, no PMS/channel-manager purchase/integration/research in V1, and extensible adapters for future needs. Business-owner approval recorded in this ChatGPT conversation on 2026-10-09. | 2026-10-09 |
| P0-15 | Lock the first 90-day MVP cut (suggested: reservation → tasks → field app → owner ledger) | TODO | | |
| P0-16 | Lock V1 languages: French + English, Arabic architecture-ready (RTL) | TODO | | |
| P0-17 | Lock currency approach: MAD primary, no single-currency assumptions in the model | TODO | | |
| P0-18 | Lock V1 payment methods: Airbnb settlement, cash, PayPal, bank transfer, manual | TODO | | |
| P0-19 | Choose the first property templates, based on Villa 405 and Villa Sultan | TODO | | |
| P0-20 | Define success metrics tied to the north star: "run tomorrow's operation in minutes, not hours" | TODO | | |

### Technology decisions (spec §73, v1.1)

| ID | Item | Status | Evidence | Date |
|---|---|---|---|---|
| P0-21 | Confirm the stack: Next.js, React, TypeScript, Tailwind, shadcn/ui, Radix, Lucide, PostgreSQL, Prisma, Zod, React Hook Form, TanStack Table/Query, Recharts | TODO | | |
| P0-22 | Confirm services: Vercel, managed PostgreSQL, Cloudflare R2, Resend, Inngest, Sentry, Auth.js | TODO | | |
| P0-23 | Confirm signature approach (Documenso self-hosted vs hosted) and who maintains it | TODO | | |
| P0-24 | Confirm provider abstractions are mandatory: StorageProvider, EmailProvider, SignatureProvider, PaymentProvider, reservation adapters | TODO | | |
| P0-25 | Set a monthly infrastructure cost ceiling for V1 | TODO | | |

---

## Phase 1 — Blueprint documents

**Done when:** The three blueprints are written, reviewed, and tested on paper against real data from Villa 405 and Villa Sultan.

**Phase test result:** TODO

### 1. Master User Flow and System Map

| ID | Item | Status | Evidence | Date |
|---|---|---|---|---|
| P1-01 | List every persona: Prospect, Owner, Guest, Admin, Operations Manager, Property Manager, Co-host, Housekeeper, Pool Technician, Gardener, Chef, Driver, Maintenance, QA Inspector, Finance/Accountant, Procurement, Revenue Manager, Contractor, family members | TODO | | |
| P1-02 | Map every major journey end to end (owner acquisition, onboarding, booking, stay, checkout, payout, month close) | TODO | | |
| P1-03 | Map the exception path for each journey (cancellation, early checkout, no-show, conflict, failed sync, missing receipt, price change) | TODO | | |
| P1-04 | Draw the system map: Public Website, Admin, Operations, Finance, Owner Portal, Guest Hub, Field App | TODO | | |
| P1-05 | Review the maps with the people who do the work (Hajar, Meriem, housekeepers) | TODO | | |

### 2. Permission and Access Matrix

| ID | Item | Status | Evidence | Date |
|---|---|---|---|---|
| P1-06 | List every role and the custom-role mechanism | TODO | | |
| P1-07 | For each role: actions (view, create, edit, void, approve, reject, assign, validate, export, pay, reconcile, configure, override) | TODO | | |
| P1-08 | For each role: data scopes (organization, city, property, owner, reservation, service, task, team, wallet) | TODO | | |
| P1-09 | For each role: data classes (operational, guest, financial, personal, sensitive) | TODO | | |
| P1-10 | List every field-level restriction (revenue, profit, commissions, salaries, wallets, supplier costs, owner payouts, bank balances) | TODO | | |
| P1-11 | Write worked examples: co-host, property manager, pool worker, owner, accountant | TODO | | |

### 3. Domain Model and Database Architecture

| ID | Item | Status | Evidence | Date |
|---|---|---|---|---|
| P1-12 | Entity list and relationships (owner, property, reservation, guest, person, user account, role, role assignment, task, transaction, ledger, payout, document, and more) | TODO | | |
| P1-13 | Exact financial transaction model, including ownership vs money location and transaction groups | TODO | | |
| P1-14 | Exact owner ledger formulas (opening, revenue, services, reimbursements, commission, expenses, payouts, adjustments, closing) | TODO | | |
| P1-15 | State machines: reservation, task, approval, payout, document, laundry batch, work order, variance | TODO | | |
| P1-16 | OTA and iCal data model with duplicate and conflict detection rules | TODO | | |
| P1-17 | Offline synchronization and conflict strategy (operation queue fields, server validation, explicit resolution) | TODO | | |
| P1-18 | Automation rule syntax (event → rule → action) and the event catalog | TODO | | |
| P1-19 | Versioning rules for configuration, agreements, price lists and documents | TODO | | |
| P1-20 | Index plan for high-frequency queries | TODO | | |
| P1-21 | API contracts and report templates | TODO | | |
| P1-22 | Backup and disaster-recovery parameters | TODO | | |

---

## Phase 2 — Foundation

**Done when:** A deployed empty app with login, tenant root, config store, event bus, jobs, storage, email, monitoring, CI and the first Golden Path test running.

**Phase test result:** TODO

### Repository, environments and delivery

| ID | Item | Status | Evidence | Date |
|---|---|---|---|---|
| P2-01 | Create the GitHub repository, branch rules and code-review rules | TODO | | |
| P2-02 | Set up CI/CD with lint, type-check, unit tests and end-to-end tests | TODO | | |
| P2-03 | Create development, staging and production environments | TODO | | |
| P2-04 | Set up secure secrets management | TODO | | |
| P2-05 | Deploy the empty app on Vercel with managed PostgreSQL | TODO | | |
| P2-06 | Configure the production domain and subdomains | TODO | | |

### Application architecture (spec §73)

| ID | Item | Status | Evidence | Date |
|---|---|---|---|---|
| P2-07 | Layering in place: Route / Server Action → Application Service → Domain Logic → Repository → PostgreSQL | TODO | | |
| P2-08 | Zod validation on every input boundary | TODO | | |
| P2-09 | Prisma schema, migrations and seed scripts | TODO | | |
| P2-10 | Provider interfaces: StorageProvider (R2), EmailProvider (Resend), SignatureProvider, PaymentProvider | TODO | | |
| P2-11 | Integration adapters normalize into the ALVILLAS domain (external → adapter → domain) | TODO | | |

### Multi-tenant root and configuration (spec §74, §76)

| ID | Item | Status | Evidence | Date |
|---|---|---|---|---|
| P2-12 | Organization is the root tenant on every table | TODO | | |
| P2-13 | Configuration store with value, scope, effective_from, effective_to, version, created_by | TODO | | |
| P2-14 | Configurable rules wired in: commission, OTA fee, owner expense treatment, approval thresholds, payout schedule, staff compensation, laundry pricing, inventory minimums, workflows, service pricing, tax, operating rules | TODO | | |
| P2-15 | No important business rule is hard-coded (code-review check) | TODO | | |

### Events and background work (spec §77, §41)

| ID | Item | Status | Evidence | Date |
|---|---|---|---|---|
| P2-16 | Domain event bus with the first events (ReservationConfirmed, InventoryBelowMinimum, ExpenseOverThreshold) | TODO | | |
| P2-17 | Inngest set up for async workflows, retries and failures surfaced to monitoring | TODO | | |
| P2-18 | Rule engine skeleton: EVENT → RULE → ACTION | TODO | | |

### Cross-cutting basics

| ID | Item | Status | Evidence | Date |
|---|---|---|---|---|
| P2-19 | Internationalization for FR and EN, with RTL structure ready for Arabic | TODO | | |
| P2-20 | Design tokens and base components (see Phase 14 for the full design system) | TODO | | |
| P2-21 | Sentry connected to frontend, backend and workflows | TODO | | |
| P2-22 | Vitest and Playwright set up | TODO | | |
| P2-23 | Automated database backups and a tested restore | TODO | | |

---

## Phase 3 — Identity, access and audit

**Done when:** A co-host can be created, scoped to one villa, and provably cannot see revenue, other villas or other wallets. Every sensitive action is audited.

**Phase test result:** TODO

### Identity model (spec §8)

| ID | Item | Status | Evidence | Date |
|---|---|---|---|---|
| P3-01 | Separate Person, User Account, Role, Role Assignment, Permissions and Data Scope | TODO | | |
| P3-02 | People can exist without an account | TODO | | |
| P3-03 | Compensation attached to the role assignment, not only the person (spec §49) | TODO | | |

### Roles and assignments (spec §9–10)

| ID | Item | Status | Evidence | Date |
|---|---|---|---|---|
| P3-04 | Custom roles are first-class, created by administrators | TODO | | |
| P3-05 | Seed the standard roles: Housekeeper, Pool Technician, Maintenance, Chef, Gardener, Driver, Co-host, QA Inspector, Operations Manager, Property Manager, Finance, Accountant, Procurement, Guest Experience, Revenue Manager, Photographer, Contractor, Regional Manager, Owner Representative, Temporary Worker | TODO | | |
| P3-06 | One person can hold several assignments across properties and roles | TODO | | |

### Authorization engine (spec §11–15)

| ID | Item | Status | Evidence | Date |
|---|---|---|---|---|
| P3-07 | RBAC: what a role can do | TODO | | |
| P3-08 | ABAC: under what conditions | TODO | | |
| P3-09 | Data scoping: organization → region/city → property → owner → reservation → job → service → financial record → wallet | TODO | | |
| P3-10 | Field-level security with masked values (for example amount shown as ••••••) | TODO | | |
| P3-11 | Permission dimensions in place: WHO, WHAT, WHERE, WHICH DATA | TODO | | |
| P3-12 | Operational access never implies financial access | TODO | | |
| P3-13 | Server-side authorization on every route and action (no UI-only checks) | TODO | | |
| P3-14 | Authorization test suite covering the co-host, property manager, pool worker and owner examples | TODO | | |

### Permission simulator (spec §16)

| ID | Item | Status | Evidence | Date |
|---|---|---|---|---|
| P3-15 | "Preview access as user" for admins | TODO | | |
| P3-16 | Shows CAN SEE / CANNOT SEE lists by assignment | TODO | | |
| P3-17 | Never changes real permissions or data | TODO | | |

### Registration and authentication (spec §17–18, v1.1 §16)

| ID | Item | Status | Evidence | Date |
|---|---|---|---|---|
| P3-18 | Invitation flow: create person → assign role → assign scope → create invitation | TODO | | |
| P3-19 | Invitation codes: random, single-use, short-lived, rate-limited, tied to the invitation, invalidated after use, audited | TODO | | |
| P3-20 | Activation: enter code → phone verification → create PIN → account active | TODO | | |
| P3-21 | Field staff sign in with phone + PIN | TODO | | |
| P3-22 | Admin and finance accounts use passkey + MFA | TODO | | |
| P3-23 | Owners use password or passkey, with optional MFA | TODO | | |
| P3-24 | Secure sessions, rate limiting, PIN reset flow | TODO | | |

### Audit trail (spec §61)

| ID | Item | Status | Evidence | Date |
|---|---|---|---|---|
| P3-25 | Audit record has who, what, when, where, before, after, reason | TODO | | |
| P3-26 | Audited events: permission changes, role assignments, financial edits, payouts, approvals, proxy validations, agreement changes, expense modifications, wallet adjustments, bank reconciliations, report generation, account access | TODO | | |
| P3-27 | Audit log is append-only and viewable only by authorized users | TODO | | |

---

## Phase 4 — Slice 1: Acquisition and property onboarding

**Done when:** A lead becomes an owner, a property, a signed agreement and a live configuration, and the owner receives the FR/EN onboarding package.

**Phase test result:** TODO

### Owner CRM (spec §4)

| ID | Item | Status | Evidence | Date |
|---|---|---|---|---|
| P4-01 | Lead pipeline with all stages: New Lead, Contacted, Qualified, Property Assessment, Proposal, Contract Draft, Sent, Viewed, Signed, ALVILLAS Onboarding, Go Live | TODO | | |
| P4-02 | Lead fields: owner/contact, phone, email, location, property type, bedrooms, current rental status, current OTAs, objectives, notes, acquisition source, status, assigned ALVILLAS representative | TODO | | |
| P4-03 | Assessment request from the public site creates a lead automatically | TODO | | |

### Property onboarding wizard (spec §5) — controlled by ALVILLAS, not the owner

| ID | Item | Status | Evidence | Date |
|---|---|---|---|---|
| P4-04 | Step 01 Owner: select or create | TODO | | |
| P4-05 | Step 02 Property: name, address, city, type, bedrooms, bathrooms, living spaces, pool, garden, parking, amenities, photos, capacity | TODO | | |
| P4-06 | Step 03 Operating profile: cleaning, inspection, pool, garden, laundry, linen, maintenance, mid-stay cleaning, breakfast, chef, transfers, groceries, wellness, other services | TODO | | |
| P4-07 | Step 04 Management agreement: commission, basis, effective date, expense treatment, responsibilities, approval rules, payout rules, notice period, special conditions | TODO | | |
| P4-08 | Step 05 Team: people and role assignments | TODO | | |
| P4-09 | Step 06 Booking channels: Airbnb, Booking.com, Vrbo, direct, agency, other | TODO | | |
| P4-10 | Step 07 Inventory: property template or custom setup | TODO | | |
| P4-11 | Step 08 Services: select and configure the catalog | TODO | | |
| P4-12 | Step 09 Workflows: standard template plus property overrides | TODO | | |
| P4-13 | Step 10 Review: validate the whole configuration | TODO | | |
| P4-14 | Step 11 Activate: property becomes operational (background workflow runs) | TODO | | |
| P4-15 | Standard property templates that new properties inherit and override | TODO | | |

### Owner onboarding package (spec §6)

| ID | Item | Status | Evidence | Date |
|---|---|---|---|---|
| P4-16 | Generated from the real configuration, not typed by hand | TODO | | |
| P4-17 | Contents: property details, what ALVILLAS provides (configured services only), financial agreement, ALVILLAS vs owner responsibilities, operating model, owner access | TODO | | |
| P4-18 | French PDF and English PDF, French email and English email (Arabic architecture-ready) | TODO | | |
| P4-19 | Owner communication language is configurable per owner | TODO | | |
| P4-20 | Delivered by email and stored in the document archive | TODO | | |

### Document versioning (spec §7, §19 v1.1)

| ID | Item | Status | Evidence | Date |
|---|---|---|---|---|
| P4-21 | Documents are immutable historical records | TODO | | |
| P4-22 | Agreement v1 → Amendment v2 with effective dates; history is never silently overwritten | TODO | | |
| P4-23 | Document, DocumentVersion, DocumentTemplate, DocumentInstance and Signature structure | TODO | | |
| P4-24 | ALVILLAS generates the PDFs; the signature provider only handles signing | TODO | | |

---

## Phase 5 — Slice 2: Reservations to operations

**Done when:** Importing a reservation creates the guest, stay, tasks and workflow, with no re-typing, and conflicts show up as exceptions.

**Phase test result:** TODO

### Reservation sources and adapters (spec §38, v1.1 §9)

| ID | Item | Status | Evidence | Date |
|---|---|---|---|---|
| P5-01 | Reservation model that every source normalizes into | TODO | | |
| P5-02 | Adapters: ICalAdapter, AirbnbAdapter, BookingComAdapter, VrboAdapter, DirectBookingAdapter, CSVAdapter | TODO | | |
| P5-03 | iCal sync first, running as a scheduled background job | TODO | | |
| P5-04 | Airbnb payout/transaction CSV import early, because iCal carries no price, guest name or payout data | TODO | | |
| P5-05 | Manual and agency bookings | TODO | | |
| P5-06 | Duplicate detection and double-booking conflict detection | TODO | | |
| P5-07 | Failed-sync alerts shown in the Command Center | TODO | | |

### Reservation lifecycle (spec §39)

| ID | Item | Status | Evidence | Date |
|---|---|---|---|---|
| P5-08 | States: Imported → Confirmed → Guest Preparation → Check-in → Staying → Checkout → Financial Reconciliation → Closed | TODO | | |
| P5-09 | Also handle: modification, cancellation, refund, early checkout, no-show, date change | TODO | | |

### Property operating profile and automation (spec §40–42, §41)

| ID | Item | Status | Evidence | Date |
|---|---|---|---|---|
| P5-10 | Operating profile per property (bedrooms, pool, daily pool service, garden, mid-stay cleaning threshold, breakfast, chef, transfers) | TODO | | |
| P5-11 | Stay workflow: pre-arrival → cleaning → inspection → inventory preparation → Guest Hub → arrival → mid-stay (if applicable) → checkout → inspection → laundry → inventory reconciliation | TODO | | |
| P5-12 | Example rules working: nights ≥ 4 → mid-stay cleaning; inventory below minimum → reorder suggestion; expense over threshold → approval request; reservation confirmed → generate workflow | TODO | | |
| P5-13 | All rules configurable without code changes | TODO | | |
| P5-14 | Financial snapshot created when a reservation is confirmed | TODO | | |

### Work management and property workspace (spec §66–67)

| ID | Item | Status | Evidence | Date |
|---|---|---|---|---|
| P5-15 | Views: Timeline, List, Day, Week, Month | TODO | | |
| P5-16 | Filters: property, worker, role, status, priority, task type, date | TODO | | |
| P5-17 | Bulk actions | TODO | | |
| P5-18 | Property workspace tabs: Overview, Calendar, Reservations, Operations, Finance, Inventory, Laundry, Maintenance, Assets, Documents, Team, Rules | TODO | | |
| P5-19 | What each user sees in the workspace depends on authorization | TODO | | |

---

## Phase 6 — Slice 3: Field app

**Done when:** A housekeeper with no internet completes a job, it syncs later, and a supervisor can validate a job on their behalf with a clean audit trail.

**Phase test result:** TODO

### Design principles (spec §19)

| ID | Item | Status | Evidence | Date |
|---|---|---|---|---|
| P6-01 | Mobile-first, large buttons, large type, icon-driven, minimal typing, one task at a time | TODO | | |
| P6-02 | Clear success and failure feedback | TODO | | |
| P6-03 | French, Arabic and English ready (RTL tested) | TODO | | |

### Housekeeper flow (spec §20–21)

| ID | Item | Status | Evidence | Date |
|---|---|---|---|---|
| P6-04 | Login → Today → My Jobs → Select Villa → Checklist → Linen → Inventory → Issue / Photo → Complete | TODO | | |
| P6-05 | Room checklist with progress (for example 6 / 6) and a large finish button | TODO | | |
| P6-06 | + / − quantity controls for linen and inventory, with direct typing still available | TODO | | |
| P6-07 | Issue reporting with photos that creates a maintenance issue | TODO | | |

### Offline-first (spec §22, v1.1 §17–18)

| ID | Item | Status | Evidence | Date |
|---|---|---|---|---|
| P6-08 | Today's relevant work downloads to the device (IndexedDB) | TODO | | |
| P6-09 | Offline operation queue with local_id, user_id, device_id, timestamp, operation, payload, sync_status | TODO | | |
| P6-10 | Operations covered: TaskCompleted, IssueCreated, LinenUpdated, InventoryAdjusted, PhotoAdded | TODO | | |
| P6-11 | Sync API: validate → detect conflicts → commit → acknowledge | TODO | | |
| P6-12 | Quantity changes recorded as movements so most conflicts disappear | TODO | | |
| P6-13 | Explicit conflict resolution screen for critical inventory and financial operations | TODO | | |
| P6-14 | Photo upload retries and background sync | TODO | | |
| P6-15 | No worker is ever blocked by lack of connection | TODO | | |
| P6-16 | Tested on slow and intermittent networks | TODO | | |

### Proxy validation (spec §23)

| ID | Item | Status | Evidence | Date |
|---|---|---|---|---|
| P6-17 | "Validate on behalf" for supervisors | TODO | | |
| P6-18 | Required fields: validator, reason, timestamp, original assignee, task, optional note/photo | TODO | | |
| P6-19 | Record shows "Performed by" and "Validated by" separately; never attributes the action to the validator | TODO | | |
| P6-20 | Works for cleaning, maintenance, pool, garden, chef, inspections, inventory and other jobs | TODO | | |

---

## Phase 7 — Slice 4: Financial engine

**Done when:** A booking flows to owner money, commission, expenses, payout and reconciliation, and every balance can be rebuilt from transactions alone.

**Phase test result:** TODO

### Core transaction model (spec §26–27)

| ID | Item | Status | Evidence | Date |
|---|---|---|---|---|
| P7-01 | Every financial event is a Transaction | TODO | | |
| P7-02 | Attributes: date, amount, account, owner, property, reservation, guest, person, supplier, category, source, payment method, ownership, status, document, approval, transaction group, audit information | TODO | | |
| P7-03 | Ownership (who the money belongs to) tracked separately from location (where it physically sits) | TODO | | |
| P7-04 | Transactions are voided or adjusted, never deleted or silently edited (spec §62) | TODO | | |
| P7-05 | Every important balance is derived from movements | TODO | | |

### Accounts, bank and cash (spec §50, §53)

| ID | Item | Status | Evidence | Date |
|---|---|---|---|---|
| P7-06 | Accounts: ALVILLAS bank accounts, cash, staff wallets, other configured accounts | TODO | | |
| P7-07 | Explicit transfers between accounts (bank to bank, bank to wallet, bank to owner payout) | TODO | | |
| P7-08 | Cash as a first-class payment method | TODO | | |
| P7-09 | Cash custody model: guest → staff → ALVILLAS, with every hand-over recorded (v1.1 §12) | TODO | | |

### Bookings and money (spec §28–29)

| ID | Item | Status | Evidence | Date |
|---|---|---|---|---|
| P7-10 | Direct booking money recorded with collected-by, account, owner, property, reservation, guest, source, purpose | TODO | | |
| P7-11 | Owner money held by ALVILLAS shows: collected, allocated, used, paid, remaining payable, where funds sit, why collected, which reservation or service generated it | TODO | | |
| P7-12 | Airbnb treated as both booking source and settlement source; expected vs actual settlement reconciled | TODO | | |
| P7-13 | PayPal, bank transfer and manual payments as provider adapters | TODO | | |
| P7-14 | Stripe left as a future provider only | TODO | | |

### Owner expenses, commission and approvals (spec §30–32)

| ID | Item | Status | Evidence | Date |
|---|---|---|---|---|
| P7-15 | Expense treatments: owner-paid, ALVILLAS-paid, included in commission, guest-paid, shared, reimbursable, deducted from payout, custom | TODO | | |
| P7-16 | Commission configurable per owner, property, agreement, booking, source and effective period | TODO | | |
| P7-17 | Commission calculation versioned; each reservation keeps its financial snapshot | TODO | | |
| P7-18 | Approval rules: none, all, threshold, category, property, percentage, emergency exception, manager then owner, custom | TODO | | |
| P7-19 | Approval requests generated automatically when a rule matches | TODO | | |

### Ledgers and payouts (spec §33–34, §50)

| ID | Item | Status | Evidence | Date |
|---|---|---|---|---|
| P7-20 | Owner ledger: opening balance + revenue + services + reimbursements − commission − expenses − payouts ± adjustments = closing balance | TODO | | |
| P7-21 | ALVILLAS ledger kept separate from owner ledgers | TODO | | |
| P7-22 | Payout models: periodic (monthly, weekly, every 15 days, custom), per booking, OTA split, custom | TODO | | |
| P7-23 | Payout state machine | TODO | | |
| P7-24 | Supplier payables, employee payables and receivables | TODO | | |
| P7-25 | Recurring expenses and recurring payouts as scheduled jobs | TODO | | |

### Team wallets (spec §24–25)

| ID | Item | Status | Evidence | Date |
|---|---|---|---|---|
| P7-26 | Wallet is a movement ledger, not an editable balance | TODO | | |
| P7-27 | Movements: advance, expense, return, compensation, compensation offset, transfer, adjustment, reconciliation | TODO | | |
| P7-28 | Workers see only their own wallet unless explicitly granted more | TODO | | |

### Company and property finance (spec §51–52)

| ID | Item | Status | Evidence | Date |
|---|---|---|---|---|
| P7-29 | ALVILLAS company expenses fully separate from property expenses | TODO | | |
| P7-30 | Categories: salaries, contractors, rent, internet, software, accounting, legal, insurance, marketing, bank fees, office, vehicles, taxes, supplies | TODO | | |
| P7-31 | Recurring and scheduled expenses, invoices, payment tracking, cost centers | TODO | | |
| P7-32 | Property finance view (for example Villa 405 mortgage recorded as a property expense) | TODO | | |

### Reconciliation and Variance Center (spec §54–55, §82)

| ID | Item | Status | Evidence | Date |
|---|---|---|---|---|
| P7-33 | Expected → Actual → Variance → Reason → Action pattern implemented once and reused | TODO | | |
| P7-34 | Reconciliations: OTA settlement, bank, laundry invoice, staff compensation, owner payout, inventory count | TODO | | |
| P7-35 | Variance Center lists every exception with expected, actual, difference, reason, action, resolved by, date | TODO | | |
| P7-36 | Bank statement import and matching | TODO | | |

### Integrity, tax and exports (spec §62, v1.1 §14–15)

| ID | Item | Status | Evidence | Date |
|---|---|---|---|---|
| P7-37 | Monthly closing and locking | TODO | | |
| P7-38 | Configurable tax engine hooks (rules, rates, categories, effective dates) | TODO | | |
| P7-39 | Accountant exports: CSV, Excel, PDF, income, expenses, owner statements, bank reconciliation, supplier and staff payments | TODO | | |
| P7-40 | Financial test suite that rebuilds every balance from transactions | TODO | | |

---

## Phase 8 — Slice 5: Guest Hub, services and chef

**Done when:** A guest completes forms, signs the agreement and orders a chef menu; the order becomes a task, revenue, cost and allocations automatically.

**Phase test result:** TODO

### Guest Hub (spec §37)

| ID | Item | Status | Evidence | Date |
|---|---|---|---|---|
| P8-01 | Unique guest link per reservation, shareable by WhatsApp, email or SMS | TODO | | |
| P8-02 | Guest can: complete profile, arrival and departure details, sign agreement, accept house rules, select services, select chef menu, order groceries, request transfers, cleaning and experiences, see relevant information, complete required forms | TODO | | |
| P8-03 | Guest ID handling follows the compliance decisions from Phase 0 | TODO | | |
| P8-04 | Guest agreement signing through the signature provider | TODO | | |
| P8-05 | FR/EN/AR guest experience, beautiful and simple on mobile | TODO | | |

### Service catalog and upsells (spec §35)

| ID | Item | Status | Evidence | Date |
|---|---|---|---|---|
| P8-06 | Each service has: selling price, internal cost, supplier/person, owner share, ALVILLAS share, tax, property availability, rules | TODO | | |
| P8-07 | Services appear only where configured for the property | TODO | | |
| P8-08 | Service orders create tasks, revenue, cost, compensation and allocations | TODO | | |

### Chef menu (spec §36)

| ID | Item | Status | Evidence | Date |
|---|---|---|---|---|
| P8-09 | Menu item: name in FR/EN/AR, description, price, serving quantity, ingredients, internal cost, chef, availability, property, preparation details, allergens (optional) | TODO | | |
| P8-10 | Guest selection generates: service order, task, ingredient requirement, revenue, cost, compensation, owner allocation, ALVILLAS allocation, margin | TODO | | |

### Signatures (v1.1 §7, §19–20)

| ID | Item | Status | Evidence | Date |
|---|---|---|---|---|
| P8-11 | SignatureProvider abstraction with Documenso as the V1 provider | TODO | | |
| P8-12 | Signing certificate decision and security ownership documented | TODO | | |
| P8-13 | Signed PDFs returned to the ALVILLAS document archive | TODO | | |

---

## Phase 9 — Slice 6: Inventory, laundry, maintenance, assets and team

**Done when:** A stay produces expected linen use, a laundry batch and an expected invoice; the real invoice is compared and the variance goes to the Variance Center.

**Phase test result:** TODO

### Inventory (spec §43–44)

| ID | Item | Status | Evidence | Date |
|---|---|---|---|---|
| P9-01 | Three categories: consumables, linen (circulating), assets | TODO | | |
| P9-02 | Inventory movement ledger: purchase, transfer, consumption, laundry send, laundry return, damage, loss, disposal, adjustment, reservation, release | TODO | | |
| P9-03 | No manual balance editing | TODO | | |
| P9-04 | Minimum levels and reorder suggestions | TODO | | |
| P9-05 | Inventory templates per property type | TODO | | |

### Laundry and linen (spec §45–46)

| ID | Item | Status | Evidence | Date |
|---|---|---|---|---|
| P9-06 | Linen and laundry are one connected system | TODO | | |
| P9-07 | Flow: stay → expected linen usage → laundry batch → expected cost → actual invoice → comparison → variance → inventory update | TODO | | |
| P9-08 | Track sent, returned, damaged, missing, rejected, lost in transit (damaged is not missing) | TODO | | |
| P9-09 | Supplier price lists, configurable and versioned | TODO | | |
| P9-10 | Expected invoice calculated; actual invoice entered or uploaded; variance and percentage shown | TODO | | |

### Maintenance and assets (spec §47–48)

| ID | Item | Status | Evidence | Date |
|---|---|---|---|---|
| P9-11 | Issues link to property, reservation, guest, task, person, supplier, expense, asset, photo, document | TODO | | |
| P9-12 | Work orders: assignment, priority, status, estimate, approval, actual cost, invoice, asset, completion, evidence | TODO | | |
| P9-13 | Asset register: item, property, purchase date and cost, warranty, condition, expected life, maintenance, replacement, disposal | TODO | | |
| P9-14 | Preventive maintenance schedules | TODO | | |

### Suppliers and team management (spec §49)

| ID | Item | Status | Evidence | Date |
|---|---|---|---|---|
| P9-15 | Supplier records with price lists and documents | TODO | | |
| P9-16 | Team module: people, roles, assignments, availability, workload, compensation, wallets, performance, documents, permissions | TODO | | |
| P9-17 | Compensation per role assignment (for example 500 DH/job at Villa A, 600 DH/month at Villa B) | TODO | | |

---

## Phase 10 — Slice 7: Owner portal

**Done when:** An owner sees only their own villas and money, approves an expense, and downloads a statement that matches the ledger.

**Phase test result:** TODO

### Owner portal (spec §56)

| ID | Item | Status | Evidence | Date |
|---|---|---|---|---|
| P10-01 | Owner sees only authorized properties | TODO | | |
| P10-02 | Sections: Overview, Reservations, Revenue, Expenses, Money collected, Money held by ALVILLAS, Payouts, Statements, Approvals, Property condition, Documents, Reports | TODO | | |
| P10-03 | Internal ALVILLAS information stays hidden unless explicitly granted | TODO | | |
| P10-04 | Owner language preference respected (FR/EN, Arabic-ready) | TODO | | |

### Approval center (spec §57)

| ID | Item | Status | Evidence | Date |
|---|---|---|---|---|
| P10-05 | Pending approvals with details and Approve / Reject | TODO | | |
| P10-06 | Only rules configured for that owner and property create requests | TODO | | |
| P10-07 | Approval decisions feed the ledger and the audit trail | TODO | | |

### Statements and reports

| ID | Item | Status | Evidence | Date |
|---|---|---|---|---|
| P10-08 | Monthly and annual owner statements generated from source data | TODO | | |
| P10-09 | Statement totals tie exactly to the owner ledger | TODO | | |

---

## Phase 11 — Slice 8: Command Center, reports and KPIs

**Done when:** Every report is generated from source data, with no manually built financial reports, and the Command Center answers "what needs me today?".

**Phase test result:** TODO

### Command Center (spec §65)

| ID | Item | Status | Evidence | Date |
|---|---|---|---|---|
| P11-01 | Today: arrivals, departures, turnovers, incomplete jobs | TODO | | |
| P11-02 | Exceptions: approvals, financial variances, low stock, maintenance, conflicts, failed syncs | TODO | | |
| P11-03 | Financial: revenue, expenses, cash, owner payable, ALVILLAS balance | TODO | | |
| P11-04 | Operations: team workload, property readiness, delayed tasks | TODO | | |

### Reports (spec §58)

| ID | Item | Status | Evidence | Date |
|---|---|---|---|---|
| P11-05 | Owner: monthly statement, annual statement, revenue, expenses, payouts, money held | TODO | | |
| P11-06 | Property: P&L, occupancy, ADR, RevPAR, expenses, service revenue, operating costs | TODO | | |
| P11-07 | ALVILLAS: company P&L, portfolio performance, cash position, commissions, margins, expenses | TODO | | |
| P11-08 | Team: productivity, completed jobs, workload, compensation, wallet activity | TODO | | |
| P11-09 | Inventory: consumption, losses, laundry, purchase, variance | TODO | | |

### KPI architecture (spec §59)

| ID | Item | Status | Evidence | Date |
|---|---|---|---|---|
| P11-10 | Filters: property, owner, team member, role, supplier, booking source, month, quarter, year, portfolio | TODO | | |
| P11-11 | Metrics: occupancy, ADR, RevPAR, gross revenue, net revenue, OTA fees, commission, owner net, service revenue, service margin, expense per stay, laundry cost, inventory consumption, staff productivity, turnaround time, maintenance, variance rate, cash position | TODO | | |
| P11-12 | Materialized or aggregated views where performance needs them | TODO | | |

---

## Phase 12 — Slice 9: Personal OS

**Done when:** Business and personal money cannot mix by accident, and family members only see what they were granted.

**Phase test result:** TODO

### Personal OS (spec §63)

| ID | Item | Status | Evidence | Date |
|---|---|---|---|---|
| P12-01 | Modules: dashboard, household, income, expenses, budget, savings, investments, assets, liabilities, goals, documents, reports | TODO | | |
| P12-02 | Separate financial domain from ALVILLAS | TODO | | |
| P12-03 | Transfers between business and personal must be explicitly categorized | TODO | | |

### Family permissions (spec §64)

| ID | Item | Status | Evidence | Date |
|---|---|---|---|---|
| P12-04 | Members: Nadir, Hajar, Anis, Youssef | TODO | | |
| P12-05 | Per-member access configurable (for example Hajar: household full, personal expenses yes, investments view-only) | TODO | | |
| P12-06 | Business access for family configured separately | TODO | | |
| P12-07 | Children receive only specifically granted access | TODO | | |

---

## Phase 13 — Public website

**Done when:** alvillas.com is live in FR/EN, the Property Assessment form creates a lead in the CRM, and Sign In reaches the OS.

**Phase test result:** TODO

### Content and structure

| ID | Item | Status | Evidence | Date |
|---|---|---|---|---|
| P13-01 | Primary message: "You own the villa. We run everything else." | TODO | | |
| P13-02 | Primary call to action: "Get a Property Assessment" (not "List your villa") | TODO | | |
| P13-03 | Navigation: ALVILLAS, Management, Services, About, Get a Property Assessment, Sign In | TODO | | |
| P13-04 | Homepage sections: Hero, What ALVILLAS manages (Property Management, Operations, Guest Experience, Owner Control), How it works (Assessment → Agreement → Onboarding → Management), Services (brief), Why ALVILLAS, Locations/selected properties, Final CTA | TODO | | |
| P13-05 | Detailed service catalog stays inside the platform and Guest Hub | TODO | | |

### Quality

| ID | Item | Status | Evidence | Date |
|---|---|---|---|---|
| P13-06 | Multilingual (FR/EN, Arabic-ready), fast, accessible, mobile-first | TODO | | |
| P13-07 | Assessment form connected to the Owner CRM | TODO | | |
| P13-08 | Analytics, SEO basics and privacy notice | TODO | | |

---

## Phase 14 — Cross-cutting hardening

**Done when:** Security, performance, notification and design checks pass on every module, not just the last one built.

**Phase test result:** TODO

### Documents and notifications (spec §60, §68–69, v1.1 §21)

| ID | Item | Status | Evidence | Date |
|---|---|---|---|---|
| P14-01 | Central document system: owner contracts, amendments, guest agreements, house rules, signatures, invoices, receipts, property, supplier and staff documents, reports | TODO | | |
| P14-02 | Sensitive documents permission-controlled, with signed URLs | TODO | | |
| P14-03 | Event-driven notifications: in-app, email, push (when the PWA need is proven), WhatsApp links first and API later | TODO | | |
| P14-04 | No internal chat; WhatsApp stays the human channel, with a path to convert messages into tasks, issues, requests, service orders or notes | TODO | | |

### Design system (spec §70–71)

| ID | Item | Status | Evidence | Date |
|---|---|---|---|---|
| P14-05 | Proprietary ALVILLAS Design System: premium, calm, neutral, clean, fast, accessible, information-dense where needed | TODO | | |
| P14-06 | Generous spacing, subtle borders, restrained shadows, no unnecessary gradients, clear hierarchy | TODO | | |
| P14-07 | Different UX per audience: Admin (powerful desktop), Manager (operational dashboard), Owner (simple financial/property dashboard), Guest (beautiful self-service), Field staff (extremely simple mobile) | TODO | | |
| P14-08 | Component library and accessibility checks (contrast, keyboard, screen reader) | TODO | | |

### Performance (spec §72)

| ID | Item | Status | Evidence | Date |
|---|---|---|---|---|
| P14-09 | Instant-feeling navigation, optimistic UI where safe, 80–250 ms micro-interactions | TODO | | |
| P14-10 | Skeleton loading, cached data, pagination, virtualized large lists | TODO | | |
| P14-11 | Efficient queries backed by the planned indexes | TODO | | |
| P14-12 | Background jobs for slow work, lazy loading | TODO | | |
| P14-13 | Correctness is never sacrificed for animation | TODO | | |

### Security (spec §78)

| ID | Item | Status | Evidence | Date |
|---|---|---|---|---|
| P14-14 | Deny by default, server-side authorization, least privilege, scoped access | TODO | | |
| P14-15 | Secure sessions, MFA for sensitive users, invitation-controlled accounts, rate limiting | TODO | | |
| P14-16 | Encrypted sensitive data where appropriate | TODO | | |
| P14-17 | No financial hard deletes | TODO | | |
| P14-18 | Secure secrets management, backups and disaster recovery drills | TODO | | |
| P14-19 | Security review or penetration test before launch | TODO | | |

### Scalability (spec §79)

| ID | Item | Status | Evidence | Date |
|---|---|---|---|---|
| P14-20 | Load test at 10, 100 and 500 properties | TODO | | |
| P14-21 | No design assumes one property, owner, manager, currency, booking source, team member or payout model | TODO | | |
| P14-22 | Search and analytics stay on PostgreSQL until real data shows a need for more | TODO | | |

---

## Phase 15 — Master end-to-end test

**Done when:** The entire chain below passes cleanly in staging with realistic data.

**Phase test result:** TODO

### Golden Path scenario — every step must pass

| ID | Item | Status | Evidence | Date |
|---|---|---|---|---|
| P15-01 | Prospect submits an assessment request | TODO | | |
| P15-02 | Lead becomes an owner | TODO | | |
| P15-03 | Agreement drafted and signed | TODO | | |
| P15-04 | Property created | TODO | | |
| P15-05 | Onboarding wizard completed and property activated | TODO | | |
| P15-06 | Team assigned | TODO | | |
| P15-07 | Permissions verified in the permission simulator | TODO | | |
| P15-08 | Owner report generated (FR and EN) | TODO | | |
| P15-09 | Owner email sent | TODO | | |
| P15-10 | Booking received | TODO | | |
| P15-11 | Guest created and Guest Hub opened | TODO | | |
| P15-12 | Guest agreement signed | TODO | | |
| P15-13 | Service ordered | TODO | | |
| P15-14 | Chef menu item selected | TODO | | |
| P15-15 | Task generated for the right worker | TODO | | |
| P15-16 | Housekeeper completes the job | TODO | | |
| P15-17 | Offline operation performed and synced | TODO | | |
| P15-18 | Proxy validation recorded correctly | TODO | | |
| P15-19 | Laundry batch created and invoice compared | TODO | | |
| P15-20 | Inventory updated | TODO | | |
| P15-21 | Expense posted (with approval if the rule applies) | TODO | | |
| P15-22 | Owner allocation correct | TODO | | |
| P15-23 | ALVILLAS allocation correct | TODO | | |
| P15-24 | Payout made | TODO | | |
| P15-25 | Bank reconciliation completed | TODO | | |
| P15-26 | Owner statement generated and matches the ledger | TODO | | |
| P15-27 | Property P&L correct | TODO | | |
| P15-28 | ALVILLAS P&L correct | TODO | | |
| P15-29 | Audit trail shows every sensitive action | TODO | | |

---

## Phase 16 — Launch readiness and rollout

**Done when:** Real villas run on the system, the team is trained, and a rollback plan exists.

**Phase test result:** TODO

### Before production

| ID | Item | Status | Evidence | Date |
|---|---|---|---|---|
| P16-01 | All red-zone items from Phase 0 closed (legal wording, tax setup validated by accountant, providers chosen, retention and privacy policies) | TODO | | |
| P16-02 | Production domain, subdomains, hosting, storage and email configured | TODO | | |
| P16-03 | Backups verified by an actual restore | TODO | | |
| P16-04 | Monitoring and alerting live (errors, failed syncs, failed workflows) | TODO | | |
| P16-05 | Data migration plan from spreadsheets, notebooks and WhatsApp history; migration rehearsed | TODO | | |
| P16-06 | Opening balances for owners, wallets, bank and inventory agreed and entered | TODO | | |

### Pilot

| ID | Item | Status | Evidence | Date |
|---|---|---|---|---|
| P16-07 | Run one or two villas (for example Villa 405 and Villa Sultan) in parallel with the old process for a full month | TODO | | |
| P16-08 | Compare system numbers with the spreadsheet and bank; log every difference | TODO | | |
| P16-09 | Collect feedback from housekeepers, co-hosts and owners | TODO | | |
| P16-10 | Fix blockers, then expand property by property | TODO | | |

### Team readiness

| ID | Item | Status | Evidence | Date |
|---|---|---|---|---|
| P16-11 | Short training for field staff (phone + PIN, checklist, offline use) | TODO | | |
| P16-12 | Training for supervisors on proxy validation and the Variance Center | TODO | | |
| P16-13 | Owner walkthrough of the portal and approval center | TODO | | |
| P16-14 | One-page support guide in FR/EN/AR | TODO | | |
| P16-15 | Incident and rollback plan written | TODO | | |

### After launch

| ID | Item | Status | Evidence | Date |
|---|---|---|---|---|
| P16-16 | Weekly review of variances and exceptions for the first two months | TODO | | |
| P16-17 | First monthly close completed and reviewed with the accountant | TODO | | |
| P16-18 | Re-evaluate deferred items: dedicated search, analytics warehouse, WhatsApp Business API, Stripe, accounting integrations | TODO | | |

---

## Appendix A — 25 non-negotiable principles (verify before every release)

| ID | Principle | Status | Evidence | Date |
|---|---|---|---|---|
| A-01 | ALVILLAS onboards properties, not owners. | TODO | | |
| A-02 | Enter once → reuse everywhere. | TODO | | |
| A-03 | No duplicate manual entry. | TODO | | |
| A-04 | No important hard-coded business rules. | TODO | | |
| A-05 | Historical financial data is auditable. | TODO | | |
| A-06 | Money ownership is separate from physical money location. | TODO | | |
| A-07 | Owner expenses are configurable. | TODO | | |
| A-08 | Owner approval rules are configurable. | TODO | | |
| A-09 | Payout rules are configurable. | TODO | | |
| A-10 | Every important balance derives from movements/transactions. | TODO | | |
| A-11 | Permissions are deny-by-default. | TODO | | |
| A-12 | Role does not equal data access. | TODO | | |
| A-13 | Operational access does not automatically imply financial access. | TODO | | |
| A-14 | People can have multiple scoped roles. | TODO | | |
| A-15 | Custom roles are first-class. | TODO | | |
| A-16 | Field workers get radically simpler UX. | TODO | | |
| A-17 | Field operations work offline. | TODO | | |
| A-18 | Supervisors can perform proxy validation with an audit trail. | TODO | | |
| A-19 | No internal chat. | TODO | | |
| A-20 | Guest Hub is structured self-service. | TODO | | |
| A-21 | Personal OS and ALVILLAS OS are separate financial domains. | TODO | | |
| A-22 | One source of truth, many views. | TODO | | |
| A-23 | Humans handle exceptions; automation handles normal operations. | TODO | | |
| A-24 | Never silently overwrite history. | TODO | | |
| A-25 | Build for 500+ properties from day one. | TODO | | |

---

## Open decisions log

| Decision | Decided | Owner | Date |
|---|---|---|---|
| | | | |
