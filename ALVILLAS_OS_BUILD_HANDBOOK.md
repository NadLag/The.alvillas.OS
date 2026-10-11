# ALVILLAS OS — Build Handbook

**Audience:** Codex / ChatGPT (the engineering agent) and the owner (Nadir).
**Purpose:** everything needed to build ALVILLAS OS to a **complete, production-ready** state. This is not an MVP plan. Every feature in the Master Specification is in scope; the roadmap only decides *order*.
**Companion files:** `ALVILLAS_OS_Master_Specification.docx` (LOCKED product spec v1.0 + technology decisions v1.1) and `AGENTS.md` (short working rules, read automatically by Codex).

---

## PART A — How to use this handbook

1. **Authority order when documents disagree:** Master Specification (locked) → this Handbook's `DEC-xx` decisions → everything else. If the spec and this handbook conflict, stop and ask the owner; do not silently pick one.
2. **The spec marks three areas as "needs detailed design" or "not yet specified".** This handbook resolves the technical ones as numbered decisions (`DEC-01…DEC-24`, Part C) so you never stall. Legal, tax and provider items (Part L) cannot be decided by an engineer: build behind interfaces, flag them, keep moving.
3. **Feature IDs** (`F-xxx-nn`, Part F) are the unit of work. Every PR names the feature IDs it delivers. `PROGRESS.md` (one line per feature ID: `TODO | IN-PROGRESS | DONE <PR/commit>`) is the only tracking file. Do not create audit registers, gap lists or status reports.
4. **Read order for a new session:** `AGENTS.md` → `PROGRESS.md` → Part D (Definition of Done) → the phase you are in (Part E) → the relevant parts of F/G/H.

### A.1 Existing code policy
An earlier codebase may exist (repository `NadLag/alvillas`). The new local build is the source of truth. Existing modules may be **mined** (copied and adapted) only if they: (a) match this handbook, (b) pass the Definition of Done in Part D including tests, and (c) are listed in an ADR (`docs/adr/`) saying what was reused. Never import whole subsystems on trust. Known issues in that code to avoid repeating: currency enum limited to MAD; French only on the public site; no way to create the first admin; 18 tables without `organization_id`; only one Playwright test.

---

## PART B — The product in one page

**ALVILLAS OS** is the private operating system of **ALVILLAS SARL**, a villa-management company in Morocco (Marrakech first). It runs the full lifecycle: owner acquisition → property onboarding → agreements → reservations → guests → Guest Hub → operations (cleaning, inspections, pool, garden, maintenance) → laundry/linen/inventory → suppliers → team and wallets → owner money / ALVILLAS money → expenses, commissions, payouts, reconciliation → documents, approvals, reporting, audit → owner portal → personal/family finance.

- **ALVILLAS OS is an independent web application:** its own repository, database, hosting project, accounts, domain and design system. It shares no code, data or infrastructure with any other product, and nothing in this build may depend on one.
- **Scale targets:** 10 → 100 → 500+ properties. Never assume one property, owner, manager, currency, booking source, team member or payout model.
- **Languages:** English + French at launch for every UI string and generated document; Arabic + RTL architecture-ready from day one (no retrofits).
- **Primary currency:** MAD, but the model supports any ISO 4217 currency.
- **North star:** *Run tomorrow's operation in minutes, not hours.*
- **Who uses it:** Admin (powerful desktop) · Manager (operational dashboard) · Owner (simple financial/property view) · Guest (beautiful self-service) · Field staff (extremely simple, offline-first mobile).
- **One platform, one data model, one authorization system, many UIs.** ALVILLAS controls the operation; owners get controlled visibility and approvals; staff get only the access they need; guests get simple self-service.

### B.1 The 25 non-negotiable principles (spec §83) — acceptance criteria for every PR
1. ALVILLAS onboards properties, not owners. 2. Enter once → reuse everywhere. 3. No duplicate manual entry. 4. No important hard-coded business rules. 5. Historical financial data is auditable. 6. Money ownership is separate from physical money location. 7. Owner expenses are configurable. 8. Owner approval rules are configurable. 9. Payout rules are configurable. 10. Every important balance derives from movements/transactions. 11. Permissions are deny-by-default. 12. Role does not equal data access. 13. Operational access does not imply financial access. 14. People can have multiple scoped roles. 15. Custom roles are first-class. 16. Field workers get radically simpler UX. 17. Field operations work offline. 18. Supervisors can proxy-validate with an audit trail. 19. No internal chat. 20. Guest Hub is structured self-service. 21. Personal OS and ALVILLAS OS are separate financial domains. 22. One source of truth, many views. 23. Humans handle exceptions; automation handles normal operations. 24. Never silently overwrite history. 25. Build for 500+ properties from day one.

**Global pattern (spec §82), implement once, reuse everywhere:** `Expected → Actual → Variance → Reason → Action` (laundry, wallets, inventory, payouts, OTA settlements, bank matching, staff compensation).

---

## PART C — Locked engineering decisions

These close the "needs detailed design" gaps. Changing one requires an ADR approved by the owner.

| ID | Decision |
|---|---|
| DEC-01 | **Money:** `Decimal(18,2)` plus `currency CHAR(3)` (ISO 4217) on every monetary row. A `Money` value object in the domain layer; never JS floats; arithmetic across currencies throws. Org has a base currency (MAD). FX table exists but conversion is out of scope until needed. Rounding: half-up to 2 decimals, applied once per defined calculation (commission = round(base × rate); owner gets the remainder). |
| DEC-02 | **IDs:** UUID v7 primary keys. Human references (`RES-0184`, `TX-…`, `PAY-…`) are per-organization sequences, never reused. |
| DEC-03 | **Time:** instants stored UTC; every property has an IANA timezone (default `Africa/Casablanca`); stay dates are calendar dates interpreted in the property timezone. |
| DEC-04 | **Tenancy:** `organization_id` on **every** business table, in every index prefix that matters. App-level scoping through one repository layer **plus** PostgreSQL Row-Level Security as defence in depth (session variable set per request/transaction). A test fails CI if any table lacks `organization_id` (explicit allow-list for global tables such as translations of system roles). |
| DEC-05 | **Auth:** Auth.js v5 as the session/credential core, with custom providers for phone+PIN and invitation activation; WebAuthn passkeys and TOTP MFA for admin/finance/owners. If Auth.js cannot satisfy a requirement, write an ADR to adopt a mature alternative (e.g. Better Auth). **Never hand-roll crypto, session storage or hashing** (use argon2id for passwords/PINs, rate-limited, lockout with backoff). |
| DEC-06 | **Ledger:** double-entry-inspired, append-only (full design in G.3). Posted rows are never updated or deleted; corrections are voids/reversals/adjustments. Enforced by DB triggers, not only by code. |
| DEC-07 | **Owner revenue accrual** is configurable per agreement: `ON_CONFIRMATION \| ON_CHECKIN \| ON_CHECKOUT \| ON_RECEIPT`; default `ON_CHECKOUT`. Cash received (location) and revenue earned (ownership) are tracked separately regardless. |
| DEC-08 | **Config engine:** one `config_rule` table (key, scope, value JSON validated by a Zod schema per key, `effective_from/to`, `version`, `created_by`, `reason`). Resolver: most-specific scope wins, then latest effective version. Reservations store an immutable **financial snapshot** of resolved rules at confirmation. |
| DEC-09 | **Events:** transactional outbox table written in the same DB transaction as the state change; a dispatcher forwards to Inngest. Consumers are idempotent. |
| DEC-10 | **API shape:** Server Actions for UI mutations; Route Handlers for sync, webhooks, file upload intents, exports, and public endpoints. Every entry point: Zod-validate → `authorize(ctx, action, resource)` → application service → domain → repository. No Prisma calls in route files or components. |
| DEC-11 | **Authorization at the data layer:** repositories take a `Scope` derived from role assignments and always filter by it; field-level masking happens in a central serializer (`present(resource, ctx)`), never in UI components. |
| DEC-12 | **Offline:** PWA + service worker + IndexedDB (Dexie) + operation queue with client-generated idempotency keys. No CRDTs. Protocol in G.8. |
| DEC-13 | **i18n:** `next-intl`; locale-prefixed routes (`/en`, `/fr`, `/ar`); every string in message files from the first commit; CI test fails when a key is missing in any active locale; logical CSS properties and `dir` support everywhere; user-generated catalog content (services, chef menu, templates) stored with per-locale fields. |
| DEC-14 | **PDF:** server-side generation owned by ALVILLAS (spec §20). Use `@react-pdf/renderer` for EN/FR. Arabic shaping needs a Chromium-based renderer: add behind a `PdfRenderer` interface via ADR when Arabic documents start. |
| DEC-15 | **Storage:** `StorageProvider` (Cloudflare R2 implementation); private by default; signed URLs with short expiry; server validates type, size and ownership on upload intents; guest ID documents additionally encrypted at rest with an app-managed key. |
| DEC-16 | **Providers behind interfaces:** `EmailProvider` (Resend), `SignatureProvider` (Documenso), `PaymentProvider` (manual/cash/bank/PayPal/Airbnb-settlement adapters), `StorageProvider` (R2), `ReservationAdapter` (iCal/CSV/Airbnb/Booking/Vrbo/Direct), `NotificationChannel` (in-app/email/WhatsApp-link/push), `PdfRenderer`. Each has an in-memory/fake implementation for tests. |
| DEC-17 | **Search:** PostgreSQL FTS + `pg_trgm`. No external search engine. **Analytics:** SQL + materialized views refreshed by jobs. |
| DEC-18 | **No hard deletes** anywhere that carries business meaning: financial rows are append-only; other rows use `archived_at`. |
| DEC-19 | **Audit log:** append-only table (DB grants forbid UPDATE/DELETE), includes who/what/when/where(ip, device, property scope)/before/after/reason/request id. Written by the application service layer, not by UI code. |
| DEC-20 | **Branching/deploy:** trunk-based, short-lived branches, PR → CI → preview → merge to `main` → auto-deploy **staging** → manual promote to **production**. Vercel previews only for PRs (use an ignored-build-step to avoid the daily deployment cap). |
| DEC-21 | **Hosting plan reality check:** Vercel *Hobby* is intended for non-commercial use; production for a company needs a paid plan (verify current terms). Choose a managed PostgreSQL plan that includes point-in-time recovery. Both are cost-ceiling items for the owner (Part L). |
| DEC-22 | **Rate limiting & abuse protection:** `RateLimiter` interface (Postgres-backed default, Redis-compatible later) on login, PIN, invitation redemption, public lead form, Guest Hub links, exports. |
| DEC-23 | **Guest Hub links:** unguessable signed tokens (≥128-bit), scoped to one reservation, expiring after checkout + grace period, revocable, rate-limited, never reveal other guests' or owners' data. |
| DEC-24 | **Feature flags:** stored in `config_rule` (scope + effective dates); used to ship incomplete screens dark, never to hide unfinished backend invariants. |

---

## PART D — Delivery model, Definition of Done, working protocol

### D.1 Delivery model
- **Live from day one.** Phase 0 ends with a real HTTPS URL, a bootstrapped admin who can log in, CI/CD, staging and production environments, and a health endpoint. Every later phase ships to staging continuously and to production behind permissions/flags. The owner should be able to open the system at any time and see real progress.
- **Vertical slices, production quality.** A slice is a complete path through UI → action → service → domain → DB → tests → deploy. Slices are never "demo-grade". Smaller is fine; lower quality is not.
- **Domain first, screens second.** The onboarding wizard, import jobs and automation are *orchestration* over the same domain services that manual screens use. Never build parallel logic ("enter once, reuse everywhere").
- **No big-bang audits.** Quality is enforced by the Definition of Done on every PR and by automated tests in CI, not by periodic review documents.

### D.2 Definition of Done (applies to every feature; nothing is DONE without all of it)
1. **Trace:** feature IDs in the PR title; `PROGRESS.md` updated in the same PR.
2. **Domain logic** lives in the domain layer with unit tests; financial and inventory invariants also have property-based tests (e.g. `fast-check`: debits = credits; balances = Σ movements).
3. **Authorization:** every read/write passes `authorize` + scope. Tests cover *allowed*, *denied*, *wrong tenant*, and *wrong scope*.
4. **Field-level security** applied through the serializer for any financial/personal/sensitive field.
5. **Audit events** for every sensitive action listed in spec §61.
6. **i18n:** EN + FR strings present, no hardcoded text, RTL-safe layout, localized validation errors and dates/numbers/currency.
7. **Validation:** Zod on client and server; server is authoritative; error states are human-readable.
8. **UX states:** loading (skeleton), empty, error, offline/slow-network behaviour where relevant.
9. **Accessibility:** keyboard operable, labelled controls, contrast AA, axe checks in E2E; field app tested at 360 px width with large touch targets (≥ 48 px).
10. **Performance:** new queries have indexes; list pages are paginated/virtualized; query-count test prevents N+1; API p95 budget in Part I.
11. **Migrations:** forward-only, expand/contract, applied from scratch and from the previous release snapshot in CI via `prisma migrate deploy`.
12. **Observability:** structured logs with request id and org id, Sentry errors, job failures surfaced, metrics for sync/jobs.
13. **E2E:** a Playwright journey for the user-visible flow; the Golden Path (Part J) extended when the feature is part of it.
14. **Security:** secrets only via env; no PII in logs; output encoding; CSRF-safe actions; uploads validated.
15. **Docs:** ADR for any non-trivial decision; seed/demo data updated; operator notes if a runbook is affected.
16. **Deployed to staging and exercised there.**
17. **No stubs counted as done.** Any stub/fake in a non-test path is listed in `docs/STUBS.md` with the real-provider ticket and a feature flag; the feature is `IN-PROGRESS` until real.

### D.3 Working protocol for Codex
- **Loop:** pick the next `TODO` feature in phase order → branch → implement with tests → run lint, typecheck, unit, integration (real PostgreSQL), Playwright **locally** → fix → PR → CI green → merge → verify on staging → update `PROGRESS.md` → next. Do not wait for the owner between features.
- **Run things.** You have a local environment: run migrations, tests and the app before claiming anything works. Paste real command output into the PR description when it matters.
- **Small PRs** (one feature or tightly related group), but complete ones. Prefer one PR per feature ID cluster over many fix-up PRs.
- **Do not:** write audit/gap/status documents; rewrite code that already passes tests; weaken or delete tests to pass; leave placeholders marked done; add dependencies that duplicate the locked stack; hard-code business rules; put secrets in the repo or chat.
- **Stop and ask the owner only for:** (1) legal/tax/accounting/data-protection decisions, (2) credentials/accounts only the owner can create (list them once, batched), (3) production data/migration approval and production promotion, (4) a change that would break a principle in B.1 or a `DEC` decision, (5) deleting or rewriting existing financial data.
- **Decide everything else yourself**, record non-trivial choices as short ADRs, and keep going.

---

## PART E — Roadmap (14 phases, all in scope)

Order is chosen so that (a) something real is online from the first phase, (b) permissions, audit, tenancy and i18n exist before any feature that depends on them, (c) the financial engine is built on stable property/reservation/team entities, and (d) the highest-risk parts (offline sync, ledger, authorization) are built early and hardened for the whole project. Sizes are relative: S < M < L < XL.

**Standing rules for every phase:** Definition of Done (D.2) on every feature · deployed to staging continuously · production promotion at each phase exit · Golden Path (Part J) extended with the phase's steps · `PROGRESS.md` is the tracker.

### Phase 0 — Foundation and live skeleton  *(M)*
**Goal:** a deployed, empty-but-real product with the full engineering pipeline.
**Build:** F-FND-01…F-FND-16 — monorepo/app structure and layer boundaries, Prisma + PostgreSQL, migrations pipeline, CI (lint, typecheck, unit, integration against real Postgres, Playwright, `prisma migrate deploy` on a fresh DB, schema-drift check, `organization_id` policy test, i18n key parity test), environments (dev/staging/prod), Vercel project + ignored-build-step, secrets handling, health endpoint, Sentry, structured logging, outbox + Inngest wiring, provider interfaces with fakes, **first-admin bootstrap** (seed creates the Organization and the first admin from `ADMIN_EMAIL`/`ADMIN_PASSWORD`; idempotent; no default password in the repo).
**Exit gate:** HTTPS URL on staging **and** production; admin can log in; CI green from a clean checkout; a PR creates a preview; rollback documented and rehearsed; backup + restore rehearsed once.

### Phase 1 — Identity, authorization, audit, i18n, design system  *(XL)*
**Goal:** the security spine. Nothing business-related is built before this passes.
**Build:** F-IDN-*, F-AUZ-*, F-AUD-*, F-I18-*, F-DSN-*, F-NTF-01…03 (email provider, in-app notification store, template system). Person / UserAccount / Role / RoleAssignment; custom roles; multiple scoped assignments; RBAC + ABAC + data scope + field-level masking; permission simulator; invitation flow (single-use short-lived codes, phone verification, PIN); admin passkey + MFA; owner password/passkey; sessions, lockout, recovery; audit log; locale routing EN/FR with RTL scaffolding; ALVILLAS Design System tokens and base components; app shells for Admin, Owner, Guest, Field.
**Exit gate:** automated permission-matrix tests (Part H) pass for every standard role; cross-tenant and cross-scope negative tests pass; co-host example from spec §13 proven (cannot see revenue, other properties, other wallets); simulator never mutates permissions; invitation abuse tests (reuse, expiry, brute force) pass; audit rows exist for all spec §61 events; every screen exists in EN and FR.

### Phase 2 — Core domain: organization, owners, properties, configuration, team  *(L)*
**Goal:** the entities everything else hangs off, with versioned rules.
**Build:** F-CFG-*, F-ORG-*, F-TPL-*, F-TEM-*. Config engine with scopes and effective dating; Owner, Property (profile, amenities, capacity, photos, timezone), Operating Profile, Management Agreement as versioned config (commission, basis, expense treatment, approval rules, payout rules, notice, special conditions), property templates + overrides, Team module (people, role assignments with compensation per assignment, availability, documents).
**Exit gate:** property created with template + overrides; agreement amended with effective dates; resolver returns correct historical vs current values (tests across effective boundaries); no business rule constants in code (lint rule / grep test for known keys).

### Phase 3 — Reservations → operations  *(XL)*
**Goal:** a booking automatically produces the work required to host it.
**Build:** F-RES-*, F-OPS-*, F-AUT-*. Reservation model + lifecycle; iCal adapter on a schedule; CSV adapter (Airbnb reservations and **Airbnb transaction/payout CSV**, because iCal carries no money); manual and direct bookings; duplicate/conflict detection; modification, cancellation, early checkout, no-show, date change; guest records; stay workflow generation; task model; automation engine (EVENT → RULE → ACTION) with rule versioning; work management views (Timeline, List, Day, Week, Month, filters, bulk actions); property workspace shell; financial snapshot captured at confirmation.
**Exit gate:** importing a feed creates reservations, guests and tasks with zero re-entry; changing dates regenerates/moves tasks without duplicates; nights ≥ threshold creates mid-stay clean; double-booking appears in Command Center exceptions; failed sync raises an alert; all rules editable without code changes.

### Phase 4 — Field app (offline PWA)  *(XL)*
**Goal:** radically simple, offline-first mobile experience for non-technical workers.
**Build:** F-FLD-*. Phone + PIN login via invitation; Today → My Jobs → Villa → Checklist → Linen → Inventory → Issue/Photo → Complete; large-button UI; `+/−` quantity controls; IndexedDB cache of the day's work; operation queue and sync API (G.8); photo capture with resumable upload; conflict screen for critical operations; proxy validation (performed-by vs validated-by); worker wallet view; installable PWA.
**Exit gate:** Playwright with network emulation: complete a job offline, reconnect, state converges; duplicate sync submissions are idempotent; conflict case produces the explicit-resolution screen; proxy validation records both identities and reason; works at 360 px on a low-end Android profile; FR/EN complete.

### Phase 5 — Financial engine  *(XL)*
**Goal:** the most important and most carefully tested part of the system.
**Build:** F-FIN-*. Accounts, ledger postings, transaction groups, ownership vs location, owner ledger and ALVILLAS ledger, payment methods (cash, bank, PayPal, Airbnb settlement, manual), cash custody, wallets, commission with snapshots, owner expense treatments, approval engine, payout models and state machine, supplier and employee payables, receivables, recurring expenses and payouts, company vs property finance, bank statement import and matching, OTA settlement reconciliation, Variance Center, monthly closing/locking, tax hooks, accountant exports.
**Exit gate:** property-based tests prove debits = credits and every balance equals the sum of its movements; the worked examples in G.3 produce exactly the stated entries; closed periods reject writes; voids/adjustments never mutate history; owner statement equals the ledger to the cent; cross-currency arithmetic is rejected; all spec §26–§34, §50–§55, §62 behaviours covered by named tests.

### Phase 6 — Documents, signatures, CRM, onboarding, owner package  *(L)*
**Goal:** from lead to live property, with legally-structured documents.
**Build:** F-DOC-*, F-CRM-*, F-ONB-*. Document/DocumentVersion/Template/Instance/Signature; immutable versions; PDF generation (EN/FR); Documenso integration behind `SignatureProvider`; owner CRM pipeline and lead capture endpoint; 11-step onboarding wizard (orchestrates Phase 2 domain services); owner onboarding package generated from real configuration in FR and EN (PDF + email); activation workflow as background job.
**Exit gate:** lead → signed agreement → active property in one automated test; amendment v2 supersedes v1 without altering v1; package contains only configured services; both language PDFs generated and archived; signed PDF returns to the archive.

### Phase 7 — Guest Hub, services, chef  *(L)*
**Build:** F-GST-*, F-SVC-*. Tokenized Guest Hub; profile/arrival/departure forms; house rules; agreement + signature; service catalog (price, cost, supplier, owner/ALVILLAS shares, tax, availability, rules); chef menu (multilingual items, ingredients, cost, availability); orders generate task + revenue + cost + compensation + allocations + margin; groceries, transfers, cleaning, experiences.
**Exit gate:** guest completes the hub on a phone; chef order creates all downstream records exactly once; hub token abuse tests pass; ID document handling follows the privacy decision (Part L).

### Phase 8 — Inventory, laundry, maintenance, assets, suppliers  *(XL)*
**Build:** F-INV-*, F-LND-*, F-MNT-*, F-AST-*, F-SUP-*. Movement-ledger inventory (no balance editing); minimums and reorder suggestions; templates; linen as circulating stock; laundry batches with expected cost from versioned supplier price lists, actual invoice, variance; damaged ≠ missing; issues and work orders with estimates/approvals/evidence; asset register and preventive schedules; supplier records and price lists.
**Exit gate:** a stay produces expected linen use → batch → expected invoice; a real invoice differing by +8.2% lands in the Variance Center with the right numbers; inventory counts are always derivable from movements; issue → expense → approval chain works end to end.

### Phase 9 — Owner portal and approvals  *(L)*
**Build:** F-OWN-*. Owner dashboard, reservations, revenue, expenses, money collected/held/paid, statements (monthly/annual), approvals center, property condition, documents, reports; language per owner.
**Exit gate:** an owner sees only their properties and only permitted fields; approving an expense posts to the ledger exactly once; statement PDF totals match ledger to the cent; owner cannot access any internal ALVILLAS data (negative tests on every endpoint).

### Phase 10 — Reports, KPIs, Command Center, notifications  *(L)*
**Build:** F-RPT-*, F-CMD-*, F-NTF-04+. Exception-first Command Center; owner/property/ALVILLAS/team/inventory reports derived from source data; KPI engine with filters; materialized views; event-driven notifications across in-app/email/WhatsApp links/push.
**Exit gate:** KPI definitions (G.9) verified against hand-computed fixtures; no report built from manual data; every Command Center exception links to the resolving screen.

### Phase 11 — Public website  *(M)*
**Build:** F-WEB-*. Premium owner-acquisition site in EN/FR (AR-ready): hero, four pillars, how it works, brief services, why ALVILLAS, locations, final CTA; **Get a Property Assessment** form → CRM lead; Sign In; SEO, sitemap, OG, analytics, accessibility.
**Exit gate:** form submission creates a lead with anti-spam protection; Lighthouse ≥ 90 on performance/accessibility/SEO (mobile); no internal data exposed.

### Phase 12 — Personal OS  *(L)*
**Build:** F-PER-*. Separate financial domain (own tenant-scoped schema area and permissions): dashboard, household, income, expenses, budget, savings, investments, assets, liabilities, goals, documents, reports; family members and per-member permissions; explicit categorized business↔personal transfers.
**Exit gate:** no query joins personal and ALVILLAS ledgers except the explicit transfer record; children's access limited to grants; permission tests for each family member profile.

### Phase 13 — Hardening, Golden Path, migration, launch  *(L)*
**Build:** F-SEC-*, F-PRF-*, F-OPR-*, F-DRC-*, F-QA-*. Security review and penetration test; load test at 10/100/500 properties; backup/restore and disaster-recovery drills; data retention and privacy implementation; accountant sign-off on exports/closing; data migration from spreadsheets/notebooks/WhatsApp history; opening balances; pilot on real villas in parallel with the old process for a full month; staff and owner training material (FR/EN/AR); runbooks; monitoring and alerting.
**Exit gate:** the 30-step Golden Path passes on staging and production-like data; pilot month reconciles to the bank and the old spreadsheets with every difference explained; all Part L items resolved or explicitly accepted by the owner in writing.

### E.1 Dependency summary
`P0 → P1 → P2 → {P3 → P4, P5 (needs P3 reservations + P2 agreements)} → P6 (needs P1 notifications, P2 entities) → P7 (needs P3, P5, P6) → P8 (needs P3, P5) → P9 (needs P5, P6) → P10 (needs all data) → P11 (needs P6 CRM) → P12 (needs P1 auth) → P13`. P11 and P12 can run in parallel with P7–P10 if capacity allows.

---

## PART F — Feature catalog (complete scope)

Format: `F-<MODULE>-<nn> · feature (key detail)`. Phase in the module heading. Spec section in brackets where useful. **Everything here is in scope for the finished product.**

### FND — Foundation (Phase 0)
- F-FND-01 · App structure with enforced layer boundaries (Route/Action → Application Service → Domain → Repository; import-boundary lint rule fails CI)
- F-FND-02 · Prisma baseline, UUID v7 keys, `organization_id` policy test (DEC-02, DEC-04)
- F-FND-03 · Migration pipeline: `migrate deploy` on fresh DB and on previous-release snapshot, drift check
- F-FND-04 · CI: lint, typecheck, unit, integration (real PostgreSQL), Playwright, i18n parity, checklist/feature-ID check
- F-FND-05 · Environments dev/staging/prod, secrets management, Zod-validated env at boot
- F-FND-06 · Vercel project, PR previews only, ignored-build-step, production promotion flow
- F-FND-07 · Health/readiness/version endpoints
- F-FND-08 · Sentry (frontend, backend, jobs) + structured logs with request id and org id
- F-FND-09 · Outbox + dispatcher + Inngest wiring (DEC-09)
- F-FND-10 · Provider interfaces and fakes: Email, Signature, Payment, Storage, ReservationAdapter, NotificationChannel, PdfRenderer, RateLimiter
- F-FND-11 · `Money` value object, currency table, rounding rules (DEC-01)
- F-FND-12 · Per-organization reference-number sequences (RES, TX, PAY, DOC…)
- F-FND-13 · First-admin bootstrap from env, idempotent, no default password
- F-FND-14 · Deterministic demo seed (never runs in production)
- F-FND-15 · Backup/restore rehearsal and runbook; rollback runbook
- F-FND-16 · Rate limiter implementation (DEC-22)

### IDN — Identity and authentication (Phase 1) [§8, §17, §18, v1.1 §16]
- F-IDN-01 · Person entity (a human can exist without an account)
- F-IDN-02 · UserAccount with multiple authentication methods
- F-IDN-03 · Phone + PIN login for field staff (argon2id, lockout with backoff, rate limited)
- F-IDN-04 · Invitation flow: create person → assign role → assign scope → invitation → one-time code → phone verification → PIN → active
- F-IDN-05 · Invitation code security: random, single-use, short-lived, rate limited, bound to its invitation, invalidated on use, audited
- F-IDN-06 · Admin and finance accounts: passkey + TOTP MFA, recovery codes
- F-IDN-07 · Owner accounts: password or passkey, optional MFA
- F-IDN-08 · Sessions: secure cookies, rotation, device list, remote revoke
- F-IDN-09 · Recovery: supervisor-initiated PIN reset, email password reset, MFA recovery
- F-IDN-10 · Account lifecycle: suspend, deactivate, offboard (revokes sessions, devices and assignments)
- F-IDN-11 · Device registration for field devices (stable `device_id` for offline queue)

### AUZ — Authorization (Phase 1) [§9–§16]
- F-AUZ-01 · Role catalog with custom roles created by admins; standard role templates seeded (Part H)
- F-AUZ-02 · Permission catalog (`resource:action` for view, create, edit, void, approve, reject, assign, validate, export, pay, reconcile, configure, override)
- F-AUZ-03 · RoleAssignment: person + role + scope + conditions + validity dates + compensation reference
- F-AUZ-04 · Multiple scoped assignments per person (spec §10 examples)
- F-AUZ-05 · Scope hierarchy: organization → region/city → property → owner → reservation → job → service → financial record → wallet
- F-AUZ-06 · `authorize(ctx, action, resource)` service used by every entry point (deny by default)
- F-AUZ-07 · ABAC conditions (assigned-to-me, status, amount threshold, time window)
- F-AUZ-08 · Field-level security: data classes (operational, guest, financial, personal, sensitive) with masking in the serializer
- F-AUZ-09 · Tenant isolation: repository scoping + PostgreSQL RLS + CI policy test
- F-AUZ-10 · Owner scoping (owner sees only own properties and permitted fields)
- F-AUZ-11 · Permission simulator ("preview access as user": CAN SEE / CANNOT SEE; read-only, never alters permissions)
- F-AUZ-12 · Auto-generated permission-matrix test suite (role × resource × action × scope)

### AUD — Audit (Phase 1) [§61]
- F-AUD-01 · Append-only audit log (DB grants forbid update/delete)
- F-AUD-02 · Required events: permission change, role assignment, financial edit, payout, approval, proxy validation, agreement change, expense modification, wallet adjustment, bank reconciliation, report generation, account access
- F-AUD-03 · Who / what / when / where / before / after / reason with redaction of secrets
- F-AUD-04 · Reason-required actions (void, adjustment, reopen period, override)
- F-AUD-05 · Audit viewer with filters and export (permission-gated)

### I18 — Internationalization (Phase 1) [§6, §19]
- F-I18-01 · Locale routing EN/FR with Arabic scaffold (`/en /fr /ar`)
- F-I18-02 · Message catalogs + CI key-parity test
- F-I18-03 · RTL support (logical CSS properties, mirrored icons, direction-safe layouts)
- F-I18-04 · Locale-aware dates, numbers, currency, plurals
- F-I18-05 · Per-user and per-owner language preference
- F-I18-06 · Multilingual content model for catalog data (services, chef menu, templates, checklists)
- F-I18-07 · Localized emails and PDFs (EN/FR now, AR-ready)

### DSN — ALVILLAS Design System (Phase 1) [§70, §71]
- F-DSN-01 · Tokens (colour, type, spacing, radius, elevation, motion 80–250 ms); premium, calm, neutral
- F-DSN-02 · Component library on Radix/shadcn primitives, restyled (forms, tables, dialogs, toasts, tabs, empty states, skeletons)
- F-DSN-03 · Admin shell (dense desktop) · F-DSN-04 · Manager shell · F-DSN-05 · Owner shell · F-DSN-06 · Guest shell · F-DSN-07 · Field shell (large type, ≥48 px targets)
- F-DSN-08 · Data table (TanStack, virtualization, saved views, CSV export)
- F-DSN-09 · Form pattern (React Hook Form + Zod, localized errors)
- F-DSN-10 · Loading/optimistic/error patterns; accessibility baseline (WCAG 2.2 AA)

### NTF — Notifications (infra Phase 1; full Phase 10) [§68, §69]
- F-NTF-01 · EmailProvider (Resend) + template system with locale variants
- F-NTF-02 · In-app notification store and bell
- F-NTF-03 · Preferences per user/channel
- F-NTF-04 · Event → recipients/channels mapping (data-driven)
- F-NTF-05 · PWA push · F-NTF-06 · WhatsApp deep-link generator (manual send) · F-NTF-07 · Digest emails · F-NTF-08 · Delivery log, retries, bounce handling
- *Explicitly no internal chat (principle 19).* Notes on records are allowed; messaging is not.

### CFG — Configuration engine (Phase 2) [§76]
- F-CFG-01 · `config_rule` schema (key, scope, value JSON, effective_from/to, version, created_by, reason)
- F-CFG-02 · Zod schema registry per config key
- F-CFG-03 · Scope resolver (most specific wins, then latest effective version)
- F-CFG-04 · Effective dating, versioning, supersede, no overwrite
- F-CFG-05 · Admin UI with history and diff; "as of date" preview
- F-CFG-06 · Snapshot function used by reservations (immutable)
- F-CFG-07 · Key catalog: commission, OTA fee, expense treatment, approval thresholds, payout schedule, staff compensation, laundry pricing, inventory minimums, workflows, service pricing, tax, operating rules, mid-stay threshold
- F-CFG-08 · Feature flags (DEC-24)

### ORG — Organization, owners, properties (Phase 2) [§4–§7, §42, §67, §74]
- F-ORG-01 · Organization tenant, settings, branding, base currency
- F-ORG-02 · Regions/cities hierarchy
- F-ORG-03 · Owner (contacts, language, representatives, payout details encrypted)
- F-ORG-04 · Property (name, address, city, type, bedrooms, bathrooms, living spaces, pool, garden, parking, amenities, photos, capacity, timezone)
- F-ORG-05 · Property–owner relationship supporting multiple owners and ownership shares
- F-ORG-06 · Operating profile (cleaning, inspection, pool, garden, laundry, linen, maintenance, mid-stay cleaning, breakfast, chef, transfers, groceries, wellness, other)
- F-ORG-07 · Management agreement as versioned config: commission, basis, effective date, expense treatment, responsibilities, approval rules, payout rules, notice period, special conditions
- F-ORG-08 · Amendments with effective dates; history never overwritten
- F-ORG-09 · Property lifecycle: draft → onboarding → active → paused → offboarded
- F-ORG-10 · Booking-channel configuration per property
- F-ORG-11 · Property workspace: Overview, Calendar, Reservations, Operations, Finance, Inventory, Laundry, Maintenance, Assets, Documents, Team, Rules (tabs visible per authorization)

### TPL — Templates (Phase 2) [§42]
- F-TPL-01 · Property templates · F-TPL-02 · Inventory templates · F-TPL-03 · Workflow templates · F-TPL-04 · Checklist templates · F-TPL-05 · Service catalog templates
- F-TPL-06 · Inherit + override with visible diff and "reset to template"

### TEM — Team management (Phase 2) [§9, §10, §49]
- F-TEM-01 · People directory · F-TEM-02 · Role assignments UI (multi-role, multi-scope)
- F-TEM-03 · Compensation per assignment (per job / per month / per hour / percentage), versioned
- F-TEM-04 · Availability and leave · F-TEM-05 · Workload view · F-TEM-06 · Performance metrics
- F-TEM-07 · Staff documents (contracts, IDs; sensitive; expiry reminders)
- F-TEM-08 · Wallet link and offboarding checks (open wallet balance, open tasks)

### RES — Reservations (Phase 3) [§38, §39]
- F-RES-01 · Normalized reservation model; `ReservationAdapter` interface
- F-RES-02 · ICalAdapter: scheduled sync, conditional fetch, modification and cancellation detection (missing UID), per-feed health
- F-RES-03 · CSVAdapter (generic) · F-RES-04 · Airbnb reservations CSV · **F-RES-05 · Airbnb transaction/payout CSV importer (money data iCal does not carry)**
- F-RES-06 · Booking.com and Vrbo adapters (iCal/CSV first, API later) · F-RES-07 · DirectBookingAdapter and manual/agency entry
- F-RES-08 · Duplicate detection (source + external id + date/guest heuristics)
- F-RES-09 · Conflict/double-booking detection with Command Center exception
- F-RES-10 · Lifecycle state machine: Imported → Confirmed → Guest Preparation → Check-in → Staying → Checkout → Financial Reconciliation → Closed
- F-RES-11 · Modification, cancellation, refund, early checkout, no-show, date change (each regenerates or adjusts downstream tasks and financials)
- F-RES-12 · Guest entity (merge duplicates, repeat-guest history)
- F-RES-13 · Calendar views (property, portfolio) with owner/maintenance blocks
- F-RES-14 · Turnover detection (same-day check-out/check-in)
- F-RES-15 · Sync health dashboard and failed-sync alerts
- F-RES-16 · Financial snapshot captured at confirmation (DEC-08)

### OPS — Operations and work management (Phase 3) [§40, §66]
- F-OPS-01 · Task model, states and history (G.2) · F-OPS-02 · Task types: cleaning, inspection, pool, garden, maintenance, laundry, inventory, chef, transfer, custom
- F-OPS-03 · Checklist templates and per-task instances with progress
- F-OPS-04 · Assignment rules by role, scope, availability, workload; reassign and swap
- F-OPS-05 · Recurring tasks (e.g. daily pool service)
- F-OPS-06 · Views: Timeline, List, Day, Week, Month; filters (property, worker, role, status, priority, type, date); saved views
- F-OPS-07 · Bulk actions (assign, reschedule, cancel, change priority)
- F-OPS-08 · Overdue/at-risk detection; property readiness status
- F-OPS-09 · Evidence on tasks (photos, notes) and issue creation from a task
- F-OPS-10 · Domain-level proxy validation record (performed by vs validated by, reason, timestamp)

### AUT — Automation engine (Phase 3) [§40–§42, §77]
- F-AUT-01 · Rule model (EVENT → CONDITIONS → ACTIONS, JSON, versioned, scoped) — syntax in G.7
- F-AUT-02 · Safe condition evaluator (no `eval`) · F-AUT-03 · Action catalog (create task, create approval request, reorder suggestion, notify, generate workflow, snapshot, create variance)
- F-AUT-04 · Stay workflow generator (pre-arrival → cleaning → inspection → inventory prep → Guest Hub → arrival → mid-stay → checkout → inspection → laundry → inventory reconciliation)
- F-AUT-05 · Admin UI with dry-run/preview and execution log with replay
- F-AUT-06 · Idempotent outcomes (re-running never duplicates tasks) · F-AUT-07 · Standard rule library seeded

### FLD — Field app (Phase 4) [§19–§23, v1.1 §17–§18]
- F-FLD-01 · Installable PWA, service worker, update flow · F-FLD-02 · Phone + PIN login UI (large keypad)
- F-FLD-03 · Today screen · F-FLD-04 · My Jobs · F-FLD-05 · Villa job detail
- F-FLD-06 · Checklist with progress (e.g. 6 / 6) and large **TERMINER / FINISH** button
- F-FLD-07 · Linen screen with `− n +` controls · F-FLD-08 · Inventory screen with `− n +` and direct typing
- F-FLD-09 · Issue + photo capture (creates a maintenance issue)
- F-FLD-10 · IndexedDB cache of the day's relevant work · F-FLD-11 · Operation queue (`local_id, user_id, device_id, timestamp, operation, payload, sync_status`)
- F-FLD-12 · Sync API push/pull with cursors and idempotency (G.8) · F-FLD-13 · Conflict resolution screen for critical operations
- F-FLD-14 · Resumable photo upload (presigned, retried) · F-FLD-15 · Supervisor proxy validation UI (validator, reason, timestamp, original assignee, task, optional note/photo)
- F-FLD-16 · Worker wallet view (own advances, expenses, compensation, balance) · F-FLD-17 · Cash collection recording (e.g. guest pays 500 DH cash for a transfer)
- F-FLD-18 · Language switch EN/FR/AR · F-FLD-19 · Sync status indicator; never blocks work
- F-FLD-20 · Device hygiene: logout wipes cached data; storage quota handling; remote revoke honoured on next sync

### FIN — Financial engine (Phase 5) [§24–§35, §50–§55, §62, v1.1 §8–§15]
- F-FIN-01 · Ledger account chart (asset accounts for locations; claim accounts for ownership) · F-FIN-02 · Transaction header + posting lines, balanced per transaction
- F-FIN-03 · Append-only enforcement (DB triggers) · F-FIN-04 · Transaction groups · F-FIN-05 · Void, reversal and adjustment transactions (reason required)
- F-FIN-06 · Accounts: bank, cash, staff wallets, OTA clearing, other · F-FIN-07 · Explicit transfers (bank↔bank, bank→wallet, bank→owner payout)
- F-FIN-08 · Payment methods and `PaymentProvider` adapters: cash, bank transfer, PayPal (optional), Airbnb settlement, manual
- F-FIN-09 · Direct booking money receipt with full provenance (collected by, account, owner, property, reservation, guest, source, purpose)
- F-FIN-10 · Airbnb settlement: expected vs actual, platform fees, owner/ALVILLAS allocation
- F-FIN-11 · Cash custody (guest → staff → ALVILLAS; collected, held, deposited, retained for authorized expenses, returned)
- F-FIN-12 · Wallet ledger: advance, expense, return, compensation, compensation offset, transfer, adjustment, reconciliation; balance always derived
- F-FIN-13 · Commission engine: per owner/property/agreement/booking/source/period; versioned; snapshot per reservation
- F-FIN-14 · Revenue accrual policy (DEC-07)
- F-FIN-15 · Owner expense treatments: owner-paid, ALVILLAS-paid, included in commission, guest-paid, shared, reimbursable, deducted from payout, custom allocation
- F-FIN-16 · Approval rules engine: none, all, threshold, category, property, percentage, emergency exception, manager→owner chain, custom conditions
- F-FIN-17 · Approval request lifecycle and effects on posting
- F-FIN-18 · Owner ledger (derived): opening + revenue + services + reimbursements − commission − expenses − payouts ± adjustments = closing
- F-FIN-19 · ALVILLAS ledger (separate) · F-FIN-20 · "Owner money held by ALVILLAS": collected, allocated, used, paid, remaining payable, where funds sit, why, which reservation/service
- F-FIN-21 · Payout models: periodic (monthly/weekly/15-day/custom), per booking, OTA split, custom · F-FIN-22 · Payout state machine and scheduling
- F-FIN-23 · Supplier payables · F-FIN-24 · Employee payables/compensation runs · F-FIN-25 · Receivables · F-FIN-26 · Recurring expenses and recurring payouts (jobs)
- F-FIN-27 · ALVILLAS company expenses (separate domain: salaries, contractors, rent, internet, software, accounting, legal, insurance, marketing, bank fees, office, vehicles, taxes, supplies; cost centers; invoices; payment tracking)
- F-FIN-28 · Property finance view (e.g. Villa 405 mortgage as a property expense)
- F-FIN-29 · Service/upsell allocation postings (owner share, ALVILLAS share, provider compensation, tax)
- F-FIN-30 · Deposits and refunds
- F-FIN-31 · Bank statement import (CSV/OFX) and matching rules · F-FIN-32 · Reconciliation framework (expected vs actual for OTA, bank, laundry, staff, owner payout, inventory)
- F-FIN-33 · Variance Center: expected, actual, difference, reason, action, resolved by, date; assignable; aging
- F-FIN-34 · Monthly closing and locking · F-FIN-35 · Privileged, reasoned period reopen (audited)
- F-FIN-36 · Tax hooks (TaxRule, TaxRate, TaxCategory, effective dates; no hard-coded Moroccan logic) · F-FIN-37 · Accountant exports: CSV, Excel, PDF; income, expenses, owner statements, bank reconciliation, supplier and staff payments
- F-FIN-38 · Receipts/invoices attached to transactions · F-FIN-39 · Financial field masking through the serializer
- F-FIN-40 · Multi-currency readiness (store currency everywhere, reject mixing) · F-FIN-41 · Nightly integrity job (debits = credits, balances rebuilt from movements and compared)
- F-FIN-42 · Statement data generation (period, opening, lines by bucket, closing) used by Owner portal and PDFs

### DOC — Documents and signatures (Phase 6) [§7, §60, v1.1 §19–§20]
- F-DOC-01 · Document, DocumentVersion, DocumentTemplate, DocumentInstance, Signature · F-DOC-02 · Templates with variables and locale variants
- F-DOC-03 · PDF generation EN/FR (AR-ready interface) · F-DOC-04 · Immutable versions; supersede/amend flow with effective dates
- F-DOC-05 · Permission-controlled archive; short-lived signed URLs · F-DOC-06 · `SignatureProvider` + Documenso integration, webhooks, states (draft, sent, viewed, signed, declined, expired)
- F-DOC-07 · Signed PDF returned to archive · F-DOC-08 · Document types: owner contracts, amendments, guest agreements, house rules, invoices, receipts, property, supplier, staff, reports
- F-DOC-09 · Expiry reminders (permits, insurance, warranties, staff docs) · F-DOC-10 · Retention tags and policy hooks · F-DOC-11 · Search

### CRM — Owner acquisition (Phase 6) [§4]
- F-CRM-01 · Lead capture API (website, manual, referral) · F-CRM-02 · Pipeline: New → Contacted → Qualified → Property Assessment → Proposal → Contract Draft → Sent → Viewed → Signed → ALVILLAS Onboarding → Go Live
- F-CRM-03 · Lead fields: owner/contact, phone, email, location, property type, bedrooms, current rental status, current OTAs, objectives, notes, source, status, assigned representative
- F-CRM-04 · Activities, reminders, assignment · F-CRM-05 · Proposal generation · F-CRM-06 · Contract flow via signatures · F-CRM-07 · Lead → Owner conversion without re-entry · F-CRM-08 · Source and conversion analytics

### ONB — Property onboarding (Phase 6) [§5, §6]
- F-ONB-01 · Wizard framework (resume, validation, review, audit)
- F-ONB-02 · Steps 01–09: Owner · Property · Operating Profile · Management Agreement · Team · Booking Channels · Inventory · Services · Workflows
- F-ONB-03 · Step 10 Review: whole-configuration validation with blocking errors · F-ONB-04 · Step 11 Activate: background workflow (create workflows, documents, email, tasks, notifications)
- F-ONB-05 · Owner package from real configuration: property, what ALVILLAS provides (configured services only), financial agreement, responsibilities, operating model, owner access
- F-ONB-06 · Bilingual delivery: FR PDF, EN PDF, FR email, EN email; language per owner · F-ONB-07 · Delivery tracking and go-live readiness checklist

### GST — Guest Hub (Phase 7) [§37]
- F-GST-01 · Tokenized links (DEC-23) · F-GST-02 · Multilingual mobile-first hub · F-GST-03 · Guest profile form · F-GST-04 · Arrival and departure details
- F-GST-05 · ID/passport capture per privacy decision · F-GST-06 · House-rules acceptance · F-GST-07 · Guest agreement with e-signature
- F-GST-08 · Service ordering · F-GST-09 · Chef menu · F-GST-10 · Groceries · F-GST-11 · Transfers · F-GST-12 · Cleaning/experience requests
- F-GST-13 · Property information (Wi-Fi, rules, contacts, emergency) · F-GST-14 · Required-form gating and check-in readiness · F-GST-15 · Link delivery (WhatsApp link, email; SMS later) · F-GST-16 · Hub status visible to staff
- *Structured self-service, not chat (principle 20).*

### SVC — Services, upsells, chef (Phase 7) [§35, §36]
- F-SVC-01 · Service catalog (selling price, internal cost, supplier/person, owner share, ALVILLAS share, tax, availability, rules, multilingual)
- F-SVC-02 · Service order lifecycle · F-SVC-03 · Order → task + revenue + cost + compensation + allocations + margin (exactly once)
- F-SVC-04 · Chef menu items (FR/EN/AR names, description, price, serving quantity, ingredients, internal cost, chef, availability, property, preparation, allergens)
- F-SVC-05 · Ingredient requirements → shopping list · F-SVC-06 · Chef compensation rules · F-SVC-07 · Grocery orders with receipts and reimbursement · F-SVC-08 · Transfers with driver assignment and cash handling

### INV — Inventory (Phase 8) [§43, §44]
- F-INV-01 · Items: consumables, linen, assets · F-INV-02 · Locations (property, store, laundry, in transit)
- F-INV-03 · Movement ledger: purchase, transfer, consumption, laundry send, laundry return, damage, loss, disposal, adjustment, reservation, release; **no manual balance editing**
- F-INV-04 · Derived stock levels · F-INV-05 · Minimums and reorder suggestions (automation) · F-INV-06 · Stocktakes with expected-vs-actual variance
- F-INV-07 · Purchases linked to expenses · F-INV-08 · Expected consumption per stay · F-INV-09 · Templates by property type · F-INV-10 · Procurement list

### LND — Laundry and linen (Phase 8) [§45, §46]
- F-LND-01 · Linen sets and circulating pool · F-LND-02 · Expected linen per stay · F-LND-03 · Batches: sent, returned, damaged, missing, rejected, lost in transit (damaged ≠ missing)
- F-LND-04 · Versioned supplier price lists · F-LND-05 · Expected invoice calculation · F-LND-06 · Actual invoice entry/upload · F-LND-07 · Variance amount and percentage → Variance Center
- F-LND-08 · Price-change detection → update-price flow · F-LND-09 · Inventory updates from batch results

### MNT — Maintenance (Phase 8) [§47]
- F-MNT-01 · Issues linked to property, reservation, guest, task, person, supplier, expense, asset, photo, document
- F-MNT-02 · Work orders: assignment, priority, status, estimate, approval, actual cost, invoice, asset, completion, evidence
- F-MNT-03 · Estimate → approval (approval engine) → work → cost → expense posting · F-MNT-04 · Contractor assignment and SLA by priority · F-MNT-05 · Property condition indicator for owners

### AST — Assets (Phase 8) [§48]
- F-AST-01 · Asset register (item, property, purchase date and cost, warranty, condition, expected life) · F-AST-02 · Warranty alerts · F-AST-03 · Preventive maintenance schedules → recurring tasks
- F-AST-04 · Replacement planning and history · F-AST-05 · Disposal records

### SUP — Suppliers (Phase 8)
- F-SUP-01 · Supplier directory and categories · F-SUP-02 · Price lists (versioned) · F-SUP-03 · Documents and contracts · F-SUP-04 · Payables and payment history · F-SUP-05 · Price-change and performance alerts

### OWN — Owner portal (Phase 9) [§56, §57]
- F-OWN-01 · Overview · F-OWN-02 · Reservations · F-OWN-03 · Revenue and expenses · F-OWN-04 · Money collected / held by ALVILLAS / paid
- F-OWN-05 · Payout history and forecast · F-OWN-06 · Statements monthly/annual (PDF + CSV) · F-OWN-07 · Approval center (pending items, Approve/Reject, only rules configured for that owner and property)
- F-OWN-08 · Property condition · F-OWN-09 · Documents · F-OWN-10 · Reports · F-OWN-11 · Owner notifications and language · F-OWN-12 · Owner-representative delegate access · F-OWN-13 · Owner invitation and onboarding to the portal

### RPT — Reports and KPIs (Phase 10) [§58, §59]
- F-RPT-01 · Report framework (parameters, PDF/CSV/Excel export, audit on generation) · F-RPT-02 · Owner reports (monthly, annual, revenue, expenses, payouts, money held)
- F-RPT-03 · Property reports (P&L, occupancy, ADR, RevPAR, expenses, service revenue, operating costs) · F-RPT-04 · ALVILLAS reports (company P&L, portfolio, cash position, commissions, margins, expenses)
- F-RPT-05 · Team reports (productivity, completed jobs, workload, compensation, wallet activity) · F-RPT-06 · Inventory reports (consumption, losses, laundry, purchase, variance)
- F-RPT-07 · KPI engine with filters (property, owner, team member, role, supplier, booking source, month, quarter, year, portfolio) · F-RPT-08 · Materialized views and refresh jobs · F-RPT-09 · Scheduled report delivery
- *Reports derive from source data; no manually constructed financial reports (spec §58).*

### CMD — Command Center (Phase 10) [§65]
- F-CMD-01 · Today: arrivals, departures, turnovers, incomplete jobs · F-CMD-02 · Exceptions: approvals, financial variances, low stock, maintenance, conflicts, failed syncs
- F-CMD-03 · Financial: revenue, expenses, cash, owner payable, ALVILLAS balance (permission-gated) · F-CMD-04 · Operations: team workload, property readiness, delayed tasks
- F-CMD-05 · Global search (Postgres FTS + trigram) · F-CMD-06 · Role-specific dashboards (manager, operations, finance)

### WEB — Public website (Phase 11) [§3]
- F-WEB-01 · Homepage: hero, four pillars (Property Management, Operations, Guest Experience, Owner Control), how it works, brief services, why ALVILLAS, locations, final CTA
- F-WEB-02 · Management, Services, About pages · F-WEB-03 · **Get a Property Assessment** form (validation, anti-spam, rate limit) → CRM lead · F-WEB-04 · Sign In entry
- F-WEB-05 · SEO, sitemap, OG, structured data · F-WEB-06 · Privacy-friendly analytics · F-WEB-07 · Performance budget and image pipeline · F-WEB-08 · EN/FR (AR-ready) copy · F-WEB-09 · Legal pages (after lawyer review)

### PER — Personal OS (Phase 12) [§63, §64]
- F-PER-01 · Isolated personal domain (separate schema area and permissions; no joins with ALVILLAS ledgers except the explicit transfer record)
- F-PER-02 · Household members and per-member permissions (Nadir, Hajar, Anis, Youssef; children only get granted access) · F-PER-03 · Income · F-PER-04 · Expenses · F-PER-05 · Budget · F-PER-06 · Savings goals
- F-PER-07 · Investments (view vs edit) · F-PER-08 · Assets, liabilities, net worth · F-PER-09 · Documents · F-PER-10 · Reports · F-PER-11 · Explicitly categorized business↔personal transfers

### SEC / PRF / OPR / DRC / QA — Hardening and launch (Phase 13)
- F-SEC-01 · Threat model · F-SEC-02 · External penetration test and fixes · F-SEC-03 · Dependency and secret scanning in CI · F-SEC-04 · CSP and security headers · F-SEC-05 · Privacy implementation (retention, export/delete workflows) · F-SEC-06 · Encryption key rotation plan · F-SEC-07 · Admin hardening and abuse monitoring
- F-PRF-01 · Load tests at 10/100/500 properties · F-PRF-02 · Query plan review · F-PRF-03 · Bundle and Core Web Vitals budgets · F-PRF-04 · Field app on low-end Android
- F-OPR-01 · Monitoring and alerts · F-OPR-02 · Runbooks · F-OPR-03 · Incident process · F-OPR-04 · Cost monitoring · F-OPR-05 · Release process and rollback drill
- F-DRC-01 · Point-in-time recovery enabled and proven · F-DRC-02 · Quarterly restore drill · F-DRC-03 · Object-storage backup · F-DRC-04 · Written RPO/RTO
- F-QA-01 · Golden Path green in CI · F-QA-02 · Regression suites · F-QA-03 · Data-migration scripts and rehearsal · F-QA-04 · Pilot month on real villas · F-QA-05 · Training material FR/EN/AR · F-QA-06 · Accessibility audit

---

## PART G — Detailed design (resolves the spec's "needs detailed design" items)

### G.1 Entity map (snake_case tables; every business table has `organization_id`, `created_at`, `updated_at`, `created_by`)
- **Identity:** `person`, `user_account`, `auth_credential` (password/PIN hashes, passkeys, TOTP), `session`, `device`, `invitation`.
- **Authorization:** `role`, `permission`, `role_permission`, `role_assignment` (person, role, scope_type, scope_id, conditions JSON, valid_from/to, compensation_ref), `field_policy` (resource, field, data_class, required_permission).
- **Core:** `organization`, `region`, `owner`, `property`, `property_owner` (share %), `operating_profile`, `template` (+ kind), `booking_channel`, `config_rule`.
- **Reservations:** `reservation`, `reservation_revision`, `guest`, `calendar_block`, `feed_source`, `feed_sync_run`, `import_batch`, `conflict`.
- **Operations:** `task`, `task_checklist_item`, `task_event`, `task_evidence`, `issue`, `automation_rule`, `automation_run`, `work_order`.
- **Sync:** `sync_op` (device_id, client_op_id unique, type, payload, status, result), `sync_cursor`.
- **Finance:** `ledger_account`, `financial_transaction`, `posting`, `transaction_group`, `payment`, `cash_custody`, `commission_snapshot`, `expense`, `expense_allocation`, `approval_request`, `payout`, `payout_item`, `supplier_invoice`, `recurring_schedule`, `bank_statement`, `bank_statement_line`, `reconciliation`, `variance`, `accounting_period`, `tax_rule`, `tax_rate`, `tax_category`.
- **Documents:** `document`, `document_version`, `document_template`, `document_instance`, `signature_request`.
- **Guest/services:** `guest_hub_link`, `guest_form_response`, `service`, `service_price_version`, `service_order`, `menu_item`, `menu_ingredient`.
- **Inventory/assets:** `inventory_item`, `inventory_location`, `inventory_movement`, `stocktake`, `stocktake_line`, `laundry_batch`, `laundry_batch_line`, `supplier`, `supplier_price_list_version`, `asset`, `asset_schedule`.
- **Platform:** `outbox_event`, `audit_log`, `notification`, `notification_delivery`, `report_definition`, `report_run`, materialized views for KPIs.
- **Personal OS (separate area, own permission set):** `personal_*` tables; never joined to ledgers except `business_personal_transfer`.

**Key rules:** reference numbers per org; money columns always paired with `currency`; enums that may grow (booking source, payment method, task type) are lookup tables, not Postgres enums; indexes on `(organization_id, property_id, …)`, reservation dates, transaction date/type, person, supplier, task status, inventory location, laundry status, approval status (spec §75).

### G.2 State machines (transitions not listed are forbidden and tested)
- **Reservation:** `IMPORTED → CONFIRMED → GUEST_PREPARATION → CHECKED_IN → STAYING → CHECKED_OUT → FINANCIAL_RECONCILIATION → CLOSED`; side exits: `CANCELLED`, `NO_SHOW`; modifications create a `reservation_revision`, never overwrite.
- **Task:** `PLANNED → ASSIGNED → IN_PROGRESS → COMPLETED`; exits `SKIPPED`, `CANCELLED`, `BLOCKED`; `OVERDUE` is derived. Completion stores `performed_by`, `validated_by` (nullable), `validation_reason`, `completion_source` (`SELF | PROXY | OFFLINE_SYNC | AUTOMATION`), timestamps. **A proxy validator is never recorded as the performer.**
- **Expense:** `DRAFT → PENDING_APPROVAL → APPROVED → POSTED`; exits `REJECTED`, `VOIDED` (via reversal posting).
- **Approval request:** `PENDING → APPROVED | REJECTED | EXPIRED | CANCELLED`; multi-step chains (manager → owner) are ordered steps on one request.
- **Payout:** `DRAFT → PENDING_APPROVAL → APPROVED → SCHEDULED → PAID → RECONCILED`; exits `FAILED`, `CANCELLED`. Posting happens at `PAID`.
- **Document:** `DRAFT → GENERATED → SENT → VIEWED → SIGNED`; exits `DECLINED`, `EXPIRED`, `SUPERSEDED`.
- **Invitation:** `CREATED → SENT → ACTIVATED`; exits `EXPIRED`, `REVOKED`.
- **Laundry batch:** `DRAFT → SENT → PARTIALLY_RETURNED → RETURNED → INVOICED → RECONCILED`.
- **Work order:** `REPORTED → TRIAGED → ESTIMATED → PENDING_APPROVAL → SCHEDULED → IN_PROGRESS → COMPLETED → VERIFIED → CLOSED`.
- **Variance:** `OPEN → INVESTIGATING → RESOLVED | WRITTEN_OFF` (write-off posts an adjustment and requires reason).
- **Accounting period:** `OPEN → CLOSED`; reopen is privileged, reasoned, audited, and time-boxed.
- **Sync op:** `PENDING → APPLIED | DUPLICATE | CONFLICT | REJECTED`.
- **Lead:** the 11 CRM stages of F-CRM-02.

### G.3 Ledger design (DEC-06)
**Model.** `financial_transaction` (header) + ≥ 2 `posting` rows. Each posting references a `ledger_account` and a side (`DEBIT`/`CREDIT`) with a positive `Decimal` amount and a currency. **Σ debits = Σ credits per transaction and currency** (DB constraint trigger + domain check). Postings carry dimensions: `owner_id, property_id, reservation_id, guest_id, person_id, supplier_id, service_order_id, category, bucket, payment_method, source, document_id`.

**Ledger accounts (per organization).**
- *Location (asset, debit-normal):* `BANK[account]`, `CASH[account]`, `WALLET[person]` (advances held by staff), `CASH_CUSTODY[person]` (guest cash collected, not yet handed over), `OTA_CLEARING[source]` (expected from Airbnb/Booking/Vrbo).
- *Ownership (claims, credit-normal):* `OWNER_PAYABLE[owner]`, `SUPPLIER_PAYABLE[supplier]`, `EMPLOYEE_PAYABLE[person]`, `GUEST_PREPAYMENT[reservation]`, `UNALLOCATED_COLLECTIONS`.
- *ALVILLAS own:* `ALVILLAS_COMMISSION_REVENUE`, `ALVILLAS_SERVICE_REVENUE`, `ALVILLAS_EXPENSE[category/cost_center]`, `VARIANCE_SUSPENSE`.

**This is how "money location" and "money ownership" stay separate:** an 8,000 DH receipt debits `BANK` (where it sits) and credits `OWNER_PAYABLE[Sultan]` (whom it belongs to).

**Worked examples (tests must reproduce these exactly).**
1. *Direct booking received, accrual ON_RECEIPT:* Dr `BANK_A` 8,000 / Cr `OWNER_PAYABLE[Sultan]` 8,000 `[bucket OWNER_REVENUE, RES-0184, source DIRECT]`.
2. *Prepaid, accrual ON_CHECKOUT:* receipt: Dr `BANK_A` 8,000 / Cr `GUEST_PREPAYMENT[RES-0184]` 8,000. At checkout: Dr `GUEST_PREPAYMENT` 8,000 / Cr `OWNER_PAYABLE[Sultan]` 8,000.
3. *Commission 20% (from snapshot):* Dr `OWNER_PAYABLE[Sultan]` 1,600 `[bucket COMMISSION]` / Cr `ALVILLAS_COMMISSION_REVENUE` 1,600.
4. *Airbnb booking, gross 5,500, platform fee 300, expected payout 5,200:* Dr `OTA_CLEARING[AIRBNB]` 5,200; Dr `OWNER_PAYABLE` 300 `[bucket OTA_FEE]` / Cr `OWNER_PAYABLE` 5,500 `[bucket OWNER_REVENUE]`. When the bank receives 5,150: Dr `BANK` 5,150; Dr `VARIANCE_SUSPENSE` 50 / Cr `OTA_CLEARING` 5,200 → opens a Variance (expected 5,200, actual 5,150).
5. *Owner expense, maintenance 2,400, approved, paid from bank:* Dr `OWNER_PAYABLE[Sultan]` 2,400 `[bucket OWNER_EXPENSE, category MAINTENANCE]` / Cr `BANK_A` 2,400. If the supplier invoice is unpaid: credit `SUPPLIER_PAYABLE[supplier]` first, pay later (Dr `SUPPLIER_PAYABLE` / Cr `BANK`).
6. *ALVILLAS-paid expense included in commission:* Dr `ALVILLAS_EXPENSE[cleaning]` / Cr `BANK` (no owner posting). The expense treatment config decides which of 5 or 6 applies.
7. *Payout 4,000:* Dr `OWNER_PAYABLE[Sultan]` 4,000 `[bucket PAYOUT]` / Cr `BANK_A` 4,000, posted when the payout reaches `PAID`.
8. *Wallet:* advance 1,500: Dr `WALLET[Miryam]` 1,500 / Cr `BANK`. Groceries 850 for an owner-paid property: Dr `OWNER_PAYABLE[o]` 850 `[GROCERIES]` / Cr `WALLET[Miryam]` 850. Supplies 200 likewise. Wallet balance = 1,500 − 850 − 200 = **450 DH**, derived from movements (spec §24).
9. *Guest cash for a 500 DH transfer, collected by Miryam:* Dr `CASH_CUSTODY[Miryam]` 500 / Cr `UNALLOCATED_COLLECTIONS` 500. At completion allocate per service config (owner share, ALVILLAS share, driver compensation) from `UNALLOCATED_COLLECTIONS`. Handover: Dr `CASH[ALVILLAS]` 500 / Cr `CASH_CUSTODY[Miryam]` 500. Partial deposit and retained-for-expense are separate movements.
10. *Staff compensation per job 500:* Dr `ALVILLAS_EXPENSE[staff]` (or the owner per agreement) / Cr `EMPLOYEE_PAYABLE[Miryam]` 500. *Compensation offset* against a wallet balance she holds: Dr `EMPLOYEE_PAYABLE` / Cr `WALLET[Miryam]` up to the lower of the two.
11. *Laundry actual invoice 920 vs expected 850:* Dr expense (owner or ALVILLAS per treatment) 920 / Cr `SUPPLIER_PAYABLE` 920; Variance opened (+70, +8.2%).
12. *Void:* a new transaction with `reverses_id` mirroring every posting. The original is untouched. *Adjustment after period close:* posted in the current open period referencing the closed one.

**Invariants (property-tested and re-checked nightly):** (1) every transaction balances per currency; (2) posted rows are immutable (trigger); (3) account balance = Σ postings; (4) Σ location balances = Σ claim balances + ALVILLAS own net position, i.e. revenue − expenses (trial balance); (5) no posting dated in a closed period; (6) no cross-currency arithmetic; (7) every posting resolves to an organization, and its dimensions belong to that same organization.

### G.4 Commission, snapshot and expense treatment
- `commission.basis` ∈ `GROSS_ACCOMMODATION | NET_OF_OTA_FEES | TOTAL_INCLUDING_SERVICES | CUSTOM_FORMULA`; rate per resolver scope (G.7). Commission posting happens at the same event as revenue accrual.
- **Snapshot (`commission_snapshot`)** stores the resolved rules (rate, basis, accrual event, expense treatments, approval thresholds, payout rule) with the config version ids used. It is created when the reservation reaches `CONFIRMED` and is immutable. Later agreement changes affect only reservations confirmed after their `effective_from`.
- **Expense treatment** (per category and agreement) ∈ `OWNER_PAID | ALVILLAS_PAID | INCLUDED_IN_COMMISSION | GUEST_PAID | SHARED(pct) | REIMBURSABLE | DEDUCTED_FROM_PAYOUT | CUSTOM_ALLOCATION`; the treatment resolves to the posting recipes in G.3 (5, 6, and mixtures via `expense_allocation`).

### G.5 Owner ledger and statements
`OWNER_PAYABLE[owner]` postings are grouped by `bucket`: `OWNER_REVENUE`, `OWNER_SERVICES`, `REIMBURSEMENT`, `COMMISSION`, `OTA_FEE`, `OWNER_EXPENSE` (+ category), `PAYOUT`, `ADJUSTMENT`. Statement for period *P*: opening = closing balance of the previous period; closing = opening + credits − debits within *P*. **Statements are generated from postings only and must tie to the cent**; PDFs store the data hash and the generation audit entry. "Money held by ALVILLAS for the owner" = `OWNER_PAYABLE` balance, with a breakdown by the physical account that holds the funds (via transaction groups) and by reservation/service source.

### G.6 Approvals and payouts
- Approval rules are config entries evaluated against an expense/payout/work order: conditions on category, amount, property, percentage of period revenue, emergency flag, requester role. Result = ordered approval steps (none, manager, owner, manager→owner). Emergency exceptions bypass the owner step but create a **post-hoc notification and audit flag**.
- Payout generation job per agreement schedule (weekly, 15-day, monthly, custom cron), per-booking trigger, or OTA-split expected settlement. A payout is computed from the owner ledger balance minus holdbacks (configurable), reviewed, approved if required, executed (manual bank transfer record in V1), then reconciled against the bank line.

### G.7 Configuration, automation, events
**`config_rule` resolution.** Scope specificity (most specific wins): `booking_source+property > agreement > property > owner > city > organization`. Ties broken by latest `effective_from`, then highest `version`. Never update a row; create a new version that supersedes.

**Automation rule (JSON, validated by Zod, versioned, scoped):**
```json
{
  "id": "midstay-clean", "version": 3, "event": "ReservationConfirmed",
  "scope": {"type": "property", "id": "<uuid>"}, "effective_from": "2026-11-01",
  "conditions": {"all": [
    {"path": "reservation.nights", "op": ">=", "value": {"config": "ops.midstay.min_nights"}}
  ]},
  "actions": [{
    "type": "create_task", "task_type": "CLEANING_MIDSTAY",
    "due": {"from": "reservation.check_in", "offset_nights": "floor(nights/2)"},
    "assign": {"role": "housekeeper", "strategy": "least_loaded"},
    "checklist_template": "checklist.midstay"
  }],
  "idempotency_key": "{{reservation.id}}:midstay"
}
```
Operators: `= != > >= < <= in not_in exists between`; combinators `all`, `any`, `not`; values may reference config keys or event fields. A restricted expression grammar (numbers, `floor/ceil/min/max`, date offsets); **no `eval`/`Function`**. Every run is logged with inputs, decision and produced ids; re-run is idempotent.

**Event catalog (minimum):** `ReservationImported, ReservationConfirmed, ReservationModified, ReservationCancelled, GuestCheckedIn, GuestCheckedOut, TaskCreated, TaskAssigned, TaskCompleted, TaskOverdue, ProxyValidated, IssueReported, WorkOrderApproved, InventoryBelowMinimum, StocktakeVariance, LaundryBatchSent, LaundryBatchReturned, LaundryInvoiced, ExpenseSubmitted, ExpenseOverThreshold, ApprovalRequested, ApprovalDecided, PaymentReceived, PayoutScheduled, PayoutPaid, BankLineUnmatched, VarianceOpened, VarianceResolved, PeriodClosed, DocumentGenerated, DocumentSent, DocumentSigned, InvitationCreated, InvitationRedeemed, PropertyActivated, LeadCreated, LeadStageChanged, GuestHubOpened, GuestFormCompleted, ServiceOrdered, SyncFailed, ConfigChanged`.

### G.8 Offline sync protocol (DEC-12)
- **Push** `POST /api/sync/push` `{device_id, op_schema_version, ops:[{client_op_id, type, payload, base_version?, client_created_at}]}` → per-op `{status: APPLIED|DUPLICATE|CONFLICT|REJECTED, server_version, conflict?:{expected, current, incoming}, error_code?}`. Unique `(device_id, client_op_id)` makes retries safe.
- **Pull** `GET /api/sync/pull?cursor=` → changes in the user's current scope (tasks, checklists, linen/inventory info, property info), tombstones, and the next cursor; paginated.
- **Ordering:** ops from one device apply in order; cross-device ordering uses server receive time. Store both `client_created_at` and `server_received_at`; never trust client clocks for business logic.
- **Authorization at apply time:** the server re-authorizes against *current* assignments. A task reassigned while the worker was offline returns `REJECTED_NOT_ASSIGNED`; evidence is preserved for the supervisor.
- **Conflict policy by operation type:** task completion = first valid completion wins, a second one is flagged `DUPLICATE_COMPLETION`; inventory/linen changes are **movements** (commutative, no conflict); absolute counts are stocktake ops carrying `expected` + `base_version` — a mismatch produces `CONFLICT` and the **explicit resolution screen** (e.g. expected 12, Miryam 10, Hajar 11); issue creation and photo adds are always append-only.
- **Photos:** presigned resumable upload separate from the op; the op references `upload_id`; retries with exponential backoff.
- **Device hygiene:** minimal data at rest, wipe on logout/revoke, quota checks, queue-age warnings, background sync where supported and sync-on-focus fallback.

### G.9 KPI definitions (all computed in the property timezone from ledger + reservations; each has a fixture test)
Occupancy = occupied nights ÷ available nights (blocks excluded; configurable) · ADR = accommodation revenue ÷ occupied nights · RevPAR = accommodation revenue ÷ available nights (= ADR × occupancy) · Gross revenue = guest-paid accommodation + services before fees · Net revenue = gross − OTA fees − refunds · OTA fees · Commission = ALVILLAS commission revenue · Owner net = revenue − commission − owner expenses (before payouts) · Service revenue and margin (revenue − provider/ingredient cost) · Expense per stay = attributable operating expenses ÷ stays · Laundry cost · Inventory consumption · Staff productivity = completed tasks and on-time rate per person/period · Turnaround time = median(checkout → property ready) · Maintenance (open/closed, mean time to resolve, cost) · Variance rate = open variance amount ÷ expected amount (and count) · Cash position = Σ bank + cash + wallet balances, split into owner-held vs ALVILLAS-own.

### G.10 Reservation normalization (iCal/CSV/API)
- **iCal limits:** feeds give dates and "reserved/not available" blocks; usually **no price, guest name or payout**. Treat "not available" without a reservation id as a `calendar_block`. Money comes from the Airbnb transaction/payout CSV (F-RES-05) or manual entry.
- **Identity:** unique `(property_id, source, external_id)`; fallback fingerprint `(property, check_in, check_out, source)`. Same UID with new dates = `ReservationModified`. A UID missing for N consecutive syncs (default 2, configurable) and not in the past = suspected cancellation → flagged for confirmation, not silently deleted.
- **Conflicts:** overlapping confirmed reservations on one property create a `conflict` record and a Command Center exception; never auto-resolve.
- **Guests:** anonymous until enriched (Guest Hub/CSV/manual); merge tool for duplicates.

---

## PART H — Permission and access matrix (baseline; admins can create custom roles and edit these)

**Legend.** Scope = default data scope of an assignment. *Op* = operational data (reservations, tasks, issues, inventory). *Guest* = guest personal data. *Fin* = any financial field. Deny by default: an empty cell means no access. Operational access never implies financial access.

| Role | Default scope | Op | Guest | Fin | Notable denials / notes |
|---|---|---|---|---|---|
| Admin | organization | full | full | full | Only role that can change roles, close/reopen periods, export all |
| Operations Manager | city/region | full (scope) | view | none unless granted | No wallets, salaries, bank balances by default |
| Property Manager | assigned properties | full (scope) | view | property-level view if granted | Cannot see other properties or portfolio P&L |
| Co-host | assigned properties | view + edit tasks/issues/services | view | none | Cannot see revenue, owner profitability, ALVILLAS profit, other wallets, salaries, company accounts (spec §13) |
| Housekeeper | assigned jobs | own jobs only | arrival info needed for the job | own wallet only | Field app only; cannot see other workers' jobs or wallets |
| Pool Technician / Gardener | assigned jobs | own jobs only | none | own wallet only | Same pattern as Housekeeper |
| Maintenance | assigned work orders | own work orders | none | own estimates/invoices | Sees cost fields only on their own work orders |
| Chef | assigned orders | own orders + menu | dietary info for assigned orders | own compensation | No other guests' data |
| Driver | assigned transfers | own transfers | pickup details | cash collected by self | No other guest data |
| QA Inspector | assigned properties | inspections, issues | none | none | Can create issues, validate tasks (audited) |
| Finance | organization | view | none | full | Cannot change roles; cannot approve own entries (maker-checker) |
| Accountant (external) | organization, read | none | none | read + export | Time-boxed, audited, no PII beyond what exports require |
| Procurement | organization/assigned | inventory, suppliers | none | purchases + supplier prices | No owner ledgers |
| Guest Experience | assigned properties | reservations, services, hub | view | service prices only | No ledgers |
| Revenue Manager | assigned properties | reservations, rates | none | revenue KPIs | No expenses/payables |
| Regional Manager | region | full (scope) | view | scope-level view if granted | — |
| Contractor / Temporary Worker | explicit jobs | listed jobs only | none | none | Expiring assignments |
| Owner | own properties | reservations, property condition | limited (guest first name / stay info per policy) | own ledger, statements, approvals | Never sees ALVILLAS profit, other owners, staff pay, supplier cost beyond own expenses |
| Owner Representative | delegated | as delegated | as delegated | as delegated | Delegation recorded and revocable |
| Guest (Hub token) | one reservation | own stay and services | own data | own order totals | No data of other guests or the owner |
| Family member (Personal OS) | per grant | n/a | n/a | personal domain only per grant | Separate from business; children only specific grants |

**Field-level policy (central `field_policy`, enforced in the serializer, DEC-11).**

| Field family | Data class | Visible to |
|---|---|---|
| Revenue, ADR, RevPAR | financial | Admin, Finance, Revenue Manager, scoped managers if granted, Owner (own) |
| Commission, ALVILLAS profit/margins | financial | Admin, Finance; Owner sees *their* commission line only |
| Staff compensation, salaries | financial/personal | Admin, Finance; the person themself |
| Wallet balances and movements | financial | Wallet owner, Admin, Finance, explicitly granted supervisors |
| Supplier costs and price lists | financial | Admin, Finance, Procurement; scoped viewers see status but amount masked (`••••••`) |
| Owner payouts and owner bank details | financial/sensitive | Admin, Finance, the owner |
| Bank balances and company accounts | financial | Admin, Finance |
| Guest ID/passport documents | sensitive | Admin, specifically authorized roles; encrypted; access audited |
| Staff documents and IDs | personal/sensitive | Admin, HR-granted roles, the person |

**Permission test generator.** For each role × resource × action × scope, tests assert allow/deny. A new route or action without a matching entry fails CI.

---

## PART I — Non-functional requirements

| Area | Requirement |
|---|---|
| Interaction speed | Navigation feels instant (route prefetch, cached data, optimistic UI where safe); micro-interactions 80–250 ms; never sacrifice correctness for animation |
| Server | API/action p95 < 300 ms for standard reads at 100 properties; p95 < 800 ms for report endpoints; background jobs for anything > 2 s |
| Web vitals (mobile, 4G) | LCP < 2.5 s, INP < 200 ms, CLS < 0.1 on public site and Guest Hub; Lighthouse ≥ 90 performance/accessibility/SEO on the public site |
| Field app | Usable on low-end Android; cold start from cache < 3 s; core flows work with no network; ≥ 48 px touch targets; 360 px width |
| Data volume | Designed and load-tested for 500 properties, ~30 reservations/property/month, ~50 postings/reservation incl. services, 5 years of history, with paginated and indexed access; list pages virtualized |
| Availability | Target 99.9 % for admin/owner/guest; field app tolerant by design (offline) |
| Backup/DR | PostgreSQL point-in-time recovery; **RPO ≤ 15 min, RTO ≤ 4 h** (to be confirmed by owner); object storage versioned/backed up; restore drill quarterly |
| Security | OWASP ASVS Level 2 as the target; CSP and security headers; argon2id; rate limiting; MFA for admin/finance; signed short-lived URLs; encrypted sensitive fields; dependency and secret scanning in CI; external penetration test before launch |
| Privacy | Data minimization; retention policy (Part L); data export/delete workflows; no PII in logs or Sentry; access to sensitive documents audited |
| Accessibility | WCAG 2.2 AA; keyboard operable; screen-reader labels; color-independent status |
| Localization | EN + FR complete everywhere; AR/RTL architecture-ready; locale-aware formats |
| Browser/device | Latest evergreen desktop browsers; iOS Safari 16+; Android Chrome current-2 |
| Observability | Structured logs (request id, org id, user id), Sentry for web/server/jobs, job dashboards, alerts (Part K) |
| Maintainability | Import-boundary enforcement; ADRs; migrations reviewed; no business constants in code; dead code removed |

---

## PART J — Testing strategy and the Golden Path

### J.1 Layers
1. **Unit (Vitest):** domain logic, Money, rule resolver, evaluator, state machines, commission, payout calculation, KPI formulas (fixtures).
2. **Property-based (fast-check):** ledger invariants (G.3), inventory movement derivation, config resolution ordering, sync idempotency.
3. **Integration (Vitest + real PostgreSQL):** repositories, RLS, triggers (immutability, period lock), migrations from scratch and from the previous release, outbox → job idempotency, **tenant-isolation generator** (every table and every endpoint queried as a different tenant must return nothing).
4. **Permission matrix tests:** generated from Part H.
5. **E2E (Playwright):** every user-facing flow; separate projects for admin (desktop), owner, guest (mobile), field (mobile, offline emulation, throttled network).
6. **Accessibility:** axe in E2E; manual screen-reader pass before launch.
7. **Load (k6):** 10/100/500-property profiles, sync endpoint storms, report generation.
8. **Security:** authorization fuzzing, IDOR tests on every ID-bearing route, invitation/PIN brute-force tests, upload abuse tests, dependency audit.
9. **Operational drills:** restore from backup, rollback a release, rotate a secret.

### J.2 The Golden Path (spec §81, **30 steps**) — automated, runs on every PR touching its areas and on every release
| # | Step | Must assert |
|---|---|---|
| 1 | Prospect submits "Get a Property Assessment" | Lead created, anti-spam passes, FR/EN confirmation |
| 2 | Lead becomes Owner | No re-entry of fields; audit entry |
| 3 | Agreement drafted, sent, signed | Documenso webhook → signed PDF archived; document v1 immutable |
| 4 | Property created | Template applied; overrides visible |
| 5 | Onboarding wizard steps 01–11 | Review blocks on invalid config; activation job completes |
| 6 | Team assigned | Multiple scoped assignments incl. compensation |
| 7 | Permissions verified | Simulator for co-host shows spec §16 lists; negative tests pass |
| 8 | Owner report generated | FR + EN PDFs contain only configured services |
| 9 | Owner email sent | Language per owner; delivery logged |
| 10 | Booking received (iCal + payout CSV) | Reservation + snapshot; tasks generated; no duplicates on re-sync |
| 11 | Guest created | Merge-safe; visible only to authorized roles |
| 12 | Guest Hub opened | Token scope enforced; forms saved |
| 13 | Agreement / signature by guest | Signed copy archived |
| 14 | Service ordered | Task + revenue + cost + allocations created exactly once |
| 15 | Chef menu item ordered | Ingredients list, chef compensation, margin |
| 16 | Task generated and assigned | Correct worker, due date, checklist |
| 17 | Housekeeper completes job | Checklist, linen and inventory movements recorded |
| 18 | Offline operation performed | Completed offline; sync converges; replay is idempotent |
| 19 | Proxy validation | Performed-by ≠ validated-by; reason recorded |
| 20 | Laundry batch | Expected cost from price-list version |
| 21 | Inventory updated | Stock equals Σ movements |
| 22 | Expense posted | Approval rule triggered above threshold; owner approves |
| 23 | Owner allocation | Ledger entries match G.3 recipes |
| 24 | ALVILLAS allocation | Commission from snapshot; company expenses separate |
| 25 | Payout made | State machine to PAID; posting correct |
| 26 | Bank reconciliation | Statement lines matched; variance opened for a difference |
| 27 | Owner statement | Ties to ledger to the cent; PDF EN/FR |
| 28 | Property P&L | Matches hand-computed fixture |
| 29 | ALVILLAS P&L | Matches fixture; no owner money counted as revenue |
| 30 | Audit trail | Every sensitive action above has an audit row with who/what/when/where/before/after/reason |

---

## PART K — Environments, configuration, release and operations

### K.1 Environment variables (names only; values set by the owner in Vercel and a git-ignored `.env`)
`DATABASE_URL`, `DIRECT_DATABASE_URL` (migrations), `APP_URL`, `AUTH_SECRET`, `ADMIN_EMAIL` and `ADMIN_PASSWORD` (bootstrap only; remove after first login), `ENCRYPTION_KEYS` (versioned keys for field encryption and MFA secrets), `RESEND_API_KEY`, `EMAIL_FROM`, `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`, `INNGEST_EVENT_KEY`, `INNGEST_SIGNING_KEY`, `SENTRY_DSN`, `SENTRY_AUTH_TOKEN`, `DOCUMENSO_URL`, `DOCUMENSO_API_TOKEN`, `DOCUMENSO_WEBHOOK_SECRET`, `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `NEXT_PUBLIC_WHATSAPP_NUMBER`, `PAYPAL_CLIENT_ID`/`PAYPAL_SECRET` (optional). All validated by a Zod schema at boot with clear errors; each variable is tagged required/optional per phase. Missing optional providers fall back to the fake with a visible "not configured" badge in admin.

### K.2 Pipeline and release
- **PR:** lint → typecheck → unit → integration (fresh Postgres, `migrate deploy`, schema drift check) → build → Playwright → preview deploy.
- **Merge to `main`:** auto-deploy to **staging** with migrations; smoke + Golden Path subset.
- **Production:** manual promotion; migrations run before traffic with a verified backup point; expand/contract only (no destructive change in the same release as the code that stops using the column).
- **Rollback:** redeploy previous build; migrations are forward-compatible by rule; restore procedure documented and rehearsed.
- **Seeds:** the demo seed is blocked in production by a guard; production only gets the organization and first-admin bootstrap.

### K.3 Alerts and runbooks
Alert on: error-rate spike, failed Inngest jobs, outbox lag, sync failure rate, iCal feed failures, DB connection saturation, slow queries, storage errors, **nightly ledger-integrity job failing (page the owner)**, backup failure, certificate/domain expiry. Runbooks in `docs/runbooks/`: deploy, rollback, restore, rotate secrets, provider outage, stuck payout, ledger integrity failure, sync storm, locked-out admin.

---

## PART L — Items only the owner (or professionals) can resolve

Build behind interfaces with fakes, flag in `docs/STUBS.md`, and keep going. **None of these may be silently assumed.**

| Item | Who | Features affected | Build policy meanwhile |
|---|---|---|---|
| Legal framing of owner money held by ALVILLAS (mandate, separate account) | Lawyer | FIN, OWN | Ledger supports it; legal wording blocks go-live with real owners |
| Owner management agreement wording (FR/EN/AR) | Lawyer | DOC, ONB | Template engine ready; placeholder text clearly marked |
| Guest agreement and house rules wording | Lawyer | GST, DOC | Same |
| Data-protection obligations for guest data and ID documents (Moroccan law, CNDP) and guest-registration obligations | Lawyer | GST, SEC, retention | Collect only what is needed; ID capture behind a flag |
| Required e-signature level for contracts; Documenso self-host vs hosted; signing certificate | Lawyer + owner | DOC | `SignatureProvider` with Documenso; certificate decision recorded |
| Tax treatment (VAT, tourist tax), commission invoicing, accounting export formats | Accountant | FIN | Tax hooks only; no hard-coded rates |
| Data retention policy and privacy policy text | Lawyer | SEC, WEB | Retention tags in place |
| Payment accounts (PayPal), Airbnb data access method (CSV exports vs partner API), WhatsApp Business API | Owner | FIN, RES, NTF | CSV + manual + wa.me links first |
| Accounts and plans: Vercel (paid plan for commercial use), PostgreSQL with PITR, R2, Resend, Sentry, Inngest, Documenso host | Owner | all | Free tiers for dev/staging only |
| Monthly infrastructure cost ceiling | Owner | all | Tracked in OPR-04 |
| Brand assets (logo, fonts, photography), approved FR/AR copy (native-speaker review) | Owner | DSN, WEB, I18 | Neutral placeholders marked as such |
| Opening balances (owners, wallets, bank, inventory), initial properties, supplier price lists | Owner + accountant | QA-03 | Import tooling ready |
| RPO/RTO acceptance | Owner | DRC | Defaults in Part I |

---

## PART M — Known traps (lessons from the earlier attempt and from the spec)

1. **Currency enum with one value** → use ISO code + `Money` (DEC-01).
2. **No first admin** → bootstrap in Phase 0 (F-FND-13).
3. **Localization retrofitted** → i18n from the first commit; CI key parity.
4. **Tables without `organization_id`** → policy test + RLS from Phase 0/1.
5. **iCal has no money** → Airbnb payout CSV importer is part of Phase 3 (F-RES-05).
6. **Audits instead of features** → no audit/status documents; Definition of Done is the quality gate.
7. **Hitting the free-plan deployment cap** → previews only for PRs; ignored build step.
8. **"Done" with stubs** → `docs/STUBS.md`; not done until real.
9. **Late offline work** → offline queue, idempotency and conflict screen are designed in Phase 1/4, tested with network emulation.
10. **Editable balances** → wallets, inventory and owner balances are always derived from movements.
11. **Hard-coded rules** → commission, thresholds, mid-stay nights, payout schedules, laundry prices come from `config_rule`.
12. **Role = access** → always scope + field policy; operational roles never get financial fields implicitly.
13. **One giant PR** → one feature cluster per PR with tests.
14. **Time zones** → property timezone for stay dates; UTC for instants; test around DST-free Morocco rules and server-time edge cases.
15. **PDF in Arabic** → react-pdf does not shape Arabic properly; plan the renderer swap early (DEC-14).

---

## PART N — Repository layout, conventions, glossary

```
src/
  app/[locale]/(public|admin|owner|guest|field)/…   # routes only: validate → authorize → call application service
  modules/<context>/{domain,application,infrastructure,ui}/
        # contexts: identity, authz, core, reservations, operations, finance, documents,
        #           guest, services, inventory, owner-portal, reporting, personal
  platform/{authz,audit,config,events,i18n,money,storage,email,jobs,pdf,rate-limit}
  db/ {schema.prisma, migrations/, sql/ (RLS, triggers), seed/}
tests/ {unit, integration, e2e, golden-path, load, fixtures}
docs/  {adr/, runbooks/, STUBS.md}
PROGRESS.md   AGENTS.md   ALVILLAS_OS_BUILD_HANDBOOK.md   ALVILLAS_OS_Master_Specification.docx
```
- **Modular monolith.** `ui → application → domain`; `infrastructure` implements ports. Modules interact through application services and domain events, never through each other's tables. Boundaries are lint-enforced.
- **Naming:** domain terms exactly as in the spec (Owner, Property, Reservation, Guest, Task, Wallet, Transaction, Posting, Payout, Variance, Operating Profile, Role Assignment, Guest Hub, Command Center).
- **Glossary:** *Ownership* = whom money belongs to; *Location* = where money physically sits; *Snapshot* = immutable copy of resolved rules at confirmation; *Variance* = Expected vs Actual difference needing a reason and action; *Proxy validation* = supervisor completing a task for someone else with both identities recorded; *Scope* = the set of records an assignment can reach; *Field policy* = per-field visibility rule.
