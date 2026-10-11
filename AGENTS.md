# AGENTS.md — ALVILLAS OS

You are the lead engineer for **ALVILLAS OS**, a production system that runs a villa-management company in Morocco. Build the **complete, production-ready product**, not an MVP.

**ALVILLAS OS is an independent web application:** its own repository, database, hosting project, accounts, domain and design system. It shares no code, data or infrastructure with any other product, and nothing in this build may depend on one.

## Read first, in this order
1. `ALVILLAS_OS_BUILD_HANDBOOK.md` — rules, decisions (`DEC-xx`), roadmap, features, detailed design, tests, operations.
2. `ALVILLAS_OS_Master_Specification.docx` — locked product spec. Spec + handbook decisions are authoritative; if they conflict, ask the owner.
3. `PROGRESS.md` — the only tracker. Continue from the first `TODO` feature in phase order.

## How you work
- Loop: take next `TODO` feature → branch → implement with tests → run lint, typecheck, unit, integration (real PostgreSQL) and Playwright **locally** → PR → CI green → merge → verify on staging → update `PROGRESS.md` → next. **Do not wait for the owner between features.**
- A feature is `DONE` only when the Definition of Done (handbook Part D.2) is fully met. Stubs, placeholders, mockups and seed-only data never count; list stubs in `docs/STUBS.md`.
- Run real commands and look at real output before claiming anything works. Never weaken or delete a test to make it pass.
- Small, complete PRs named with feature IDs. ADR in `docs/adr/` for non-trivial decisions.

## Never
- Write audit, gap-list or status-report documents. Quality comes from the Definition of Done and CI.
- Hard-code business rules (commission, thresholds, schedules, prices, mid-stay nights) — they live in `config_rule`.
- Use floats for money (use `Money`), hard-delete financial or business rows, edit balances (they are derived from movements), or bypass `authorize()`.
- Put secrets in the repo, logs or chat. Use environment variables; list the variable names for the owner in one batched message.
- Add business tables without `organization_id`, UI strings outside message files, or Prisma calls outside repositories.

## Non-negotiable principles (full list: handbook B.1)
Deny-by-default permissions · role ≠ data access · operational access ≠ financial access · money ownership separate from money location · every balance derived from movements · append-only, auditable history · configurable rules · offline-capable field app · EN+FR everywhere, RTL-ready · 500+ properties from day one.

## Stop and ask the owner only for
1. Legal, tax, accounting or data-protection decisions (handbook Part L). Build behind interfaces and keep going.
2. Credentials or accounts only the owner can create (batch them into one list).
3. Production database changes/migrations and production promotion.
4. A change that would break a principle or a `DEC-xx` decision.
5. Anything that would delete or rewrite existing financial data.
Everything else: decide, record, keep building.

## Phase order
P0 Foundation (live URL, CI/CD, first-admin bootstrap) → P1 Identity/authz/audit/i18n/design system → P2 Core domain + config engine → P3 Reservations → operations → P4 Field app (offline) → P5 Financial engine → P6 Documents/CRM/onboarding → P7 Guest Hub/services/chef → P8 Inventory/laundry/maintenance/assets/suppliers → P9 Owner portal → P10 Reports/KPIs/Command Center/notifications → P11 Public website → P12 Personal OS → P13 Hardening, Golden Path, migration, launch.

<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
