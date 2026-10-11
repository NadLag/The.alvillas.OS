# PROGRESS.md - ALVILLAS OS

Format: one line per handbook feature ID as `F-ID | TODO | IN-PROGRESS | DONE <PR/commit evidence>`.

Archived checklist evidence remains in `docs/archive/`; it is not converted to feature `DONE` status unless the handbook Definition of Done is verified.

F-FND-01 | DONE PR #1 d1f1b81 | CI: `npm run lint`, `npm run typecheck`, `npm run build`, `npm run check:boundaries`, `tests/e2e/health.spec.ts`.
F-FND-02 | DONE PR #1 d1f1b81 | CI: `npm run check:organization-id`, `npm run check:schema-drift`, `tests/integration/postgres-migration.test.ts`.
F-FND-03 | DONE PR #1 d1f1b81 | CI: `tests/integration/postgres-migration.test.ts`, `npm run check:schema-drift`.
F-FND-04 | DONE PR #1 d1f1b81 | CI workflow ran `lint`, `typecheck`, policy checks, unit, integration, build and Playwright.
F-FND-05 | IN-PROGRESS | Env schema and `.env.example` exist; Preview Neon DB and staging app secrets configured separately from Production; production values/provider completion pending owner.
F-FND-06 | IN-PROGRESS | `vercel.json` guard exists; Preview Neon staging resource `the-alvillas-os-staging` provisioned and migrations applied. S7 proved production Git auto-deploy is blocked: Vercel project production branch is `main`, ignored-build command skips `VERCEL_ENV=production`, and merge-triggered production deployment `dpl_FdX9AFK6zZrgFkf27erhptEMhxpy` was canceled. GitHub `deploy-staging` run `38165949728` failed because staging `VERCEL_TOKEN`/`VERCEL_ORG_ID`/`VERCEL_PROJECT_ID` are unset; owner/environment setup pending.
F-FND-07 | DONE PR #1 d1f1b81 | CI: `tests/unit/health.test.ts`, `tests/e2e/health.spec.ts`.
F-FND-08 | IN-PROGRESS | Structured logger covered by `tests/unit/logger.test.ts`; Sentry wiring pending.
F-FND-09 | IN-PROGRESS | Outbox covered by `tests/unit/outbox-dispatcher.test.ts`; Inngest wiring pending.
F-FND-10 | DONE PR #1 d1f1b81 | CI: `tests/unit/fake-providers.test.ts`; fakes listed in `docs/STUBS.md`.
F-FND-11 | DONE PR #1 d1f1b81 | CI: `tests/unit/money.test.ts`, `npm run check:ledger`, `tests/integration/postgres-migration.test.ts`.
F-FND-12 | DONE PR #1 d1f1b81 | CI: `tests/unit/reference-number.test.ts`, `tests/integration/postgres-migration.test.ts`.
F-FND-13 | IN-PROGRESS | Bootstrap covered by `tests/unit/bootstrap-admin.test.ts` and auth E2E; staging bootstrap executed and tenant admin count verified; PR/CI/merge still pending.
F-FND-14 | IN-PROGRESS | Demo seed covered by `tests/unit/demo-seed.test.ts`; full demo dataset pending.
F-FND-15 | IN-PROGRESS | Runbooks exist; managed PostgreSQL backup/restore rehearsal pending.
F-FND-16 | IN-PROGRESS | Rate limiter covered by `tests/unit/rate-limiter.test.ts`; login adoption pending.
F-IDN-01 | IN-PROGRESS | Branch `f-fnd-01-foundation-skeleton`: tenant-scoped Person table added for first-admin bootstrap. Full lifecycle/profile model incomplete.
F-IDN-02 | IN-PROGRESS | Auth.js credentials login with argon2id covered by `tests/e2e/auth.spec.ts`; MFA/passkeys incomplete.
F-IDN-03 | TODO |
F-IDN-04 | TODO |
F-IDN-05 | TODO |
F-IDN-06 | TODO |
F-IDN-07 | TODO |
F-IDN-08 | IN-PROGRESS | Auth.js JWT session and logout covered by `tests/e2e/auth.spec.ts`; device list/revoke incomplete.
F-IDN-09 | TODO |
F-IDN-10 | TODO |
F-IDN-11 | TODO |
F-AUZ-01 | TODO |
F-AUZ-02 | TODO |
F-AUZ-03 | TODO |
F-AUZ-04 | TODO |
F-AUZ-05 | TODO |
F-AUZ-06 | IN-PROGRESS | Branch `f-fnd-01-foundation-skeleton`: deny-by-default `authorize` primitive with unit tests added. Not yet wired through every entry point.
F-AUZ-07 | TODO |
F-AUZ-08 | IN-PROGRESS | Branch `f-fnd-01-foundation-skeleton`: central `present(resource, ctx)` serializer with data-class field masking and unit tests added. Not yet adopted across real resources/endpoints.
F-AUZ-09 | IN-PROGRESS | Branch `f-fnd-01-foundation-skeleton`: Prisma tenant columns, ENABLE/FORCE RLS policies, policy check, and `withTenant` session helper added. Repository adoption and real-Postgres RLS verification incomplete.
F-AUZ-10 | TODO |
F-AUZ-11 | TODO |
F-AUZ-12 | TODO |
F-AUD-01 | IN-PROGRESS | Branch `f-fnd-01-foundation-skeleton`: `audit_log` table, append-only trigger migration, service-layer writer, grant revocation migration, and audit CI guard added. Full event coverage and real-Postgres verification incomplete.
F-AUD-02 | TODO |
F-AUD-03 | IN-PROGRESS | Branch `f-fnd-01-foundation-skeleton`: audit schema and writer include who/what/when/where/before/after/reason/request id fields. Redaction and full app coverage incomplete.
F-AUD-04 | TODO |
F-AUD-05 | TODO |
F-I18-01 | IN-PROGRESS | Branch `f-fnd-01-foundation-skeleton`: locale-prefixed `/en`, `/fr`, `/ar` routes, localized metadata, and middleware added. Full app coverage incomplete.
F-I18-02 | IN-PROGRESS | Branch `f-fnd-01-foundation-skeleton`: EN/FR/AR message catalogs and key-parity check added. Full string extraction incomplete.
F-I18-03 | IN-PROGRESS | Branch `f-fnd-01-foundation-skeleton`: `dir` support and RTL-safe CSS guard added. Full component/icon mirroring coverage incomplete.
F-I18-04 | IN-PROGRESS | Branch `f-fnd-01-foundation-skeleton`: locale-aware date, number, currency, and plural formatter utilities with unit tests added. Full app adoption incomplete.
F-I18-05 | IN-PROGRESS | EN/FR switch in login/app shell; persisted per-user preference incomplete.
F-I18-06 | TODO |
F-I18-07 | TODO |
F-DSN-01 | IN-PROGRESS | Base CSS tokens applied to login/app shell; full token/component package incomplete.
F-DSN-02 | TODO |
F-DSN-03 | IN-PROGRESS | Authenticated admin shell covered by `tests/e2e/auth.spec.ts`; dense admin navigation incomplete.
F-DSN-04 | TODO |
F-DSN-05 | TODO |
F-DSN-06 | TODO |
F-DSN-07 | TODO |
F-DSN-08 | TODO |
F-DSN-09 | TODO |
F-DSN-10 | TODO |
F-NTF-01 | TODO |
F-NTF-02 | TODO |
F-NTF-03 | TODO |
F-NTF-04 | TODO |
F-NTF-05 | TODO |
F-NTF-06 | TODO |
F-NTF-07 | TODO |
F-NTF-08 | TODO |
F-CFG-01 | TODO |
F-CFG-02 | TODO |
F-CFG-03 | TODO |
F-CFG-04 | TODO |
F-CFG-05 | TODO |
F-CFG-06 | IN-PROGRESS | S6 uses tenant-scoped `finance.commission` config rules to resolve property > owner > organization commission rules for reservation revenue posting. Evidence: PR #12 `543fee1`, CI run `38158574875` green, protected Preview staging `dpl_GZgCD9jfoqFJXstKf9ux8dt2sm5L` verified 20% property rule on an 8000.00 MAD reservation.
F-CFG-07 | IN-PROGRESS | S6 snapshots the selected commission rule, owner share, basis and accrual event into immutable `commission_snapshot` rows before posting. Evidence: PR #12 `543fee1`; CI `tests/integration/postgres-migration.test.ts` asserts the snapshotted property rule/version and future rule isolation.
F-CFG-08 | TODO |
F-ORG-01 | TODO |
F-ORG-02 | TODO |
F-ORG-03 | IN-PROGRESS | Authenticated owner create/list/detail slice with scoped service/repository, validation, audit event and EN/FR UI added on `f-org-03-04-owners-properties`; representatives and encrypted payout details still pending.
F-ORG-04 | IN-PROGRESS | Authenticated property create/list/detail slice with owner link, capacity, amenities, photos-as-URLs, timezone, scoped service/repository, validation, audit event and EN/FR UI added; richer photo storage/onboarding profile still pending.
F-ORG-05 | TODO |
F-ORG-06 | TODO |
F-ORG-07 | TODO |
F-ORG-08 | TODO |
F-ORG-09 | TODO |
F-ORG-10 | TODO |
F-ORG-11 | TODO |
F-TPL-01 | TODO |
F-TPL-02 | TODO |
F-TPL-03 | TODO |
F-TPL-04 | TODO |
F-TPL-05 | TODO |
F-TPL-06 | TODO |
F-TEM-01 | TODO |
F-TEM-02 | TODO |
F-TEM-03 | TODO |
F-TEM-04 | TODO |
F-TEM-05 | TODO |
F-TEM-06 | TODO |
F-TEM-07 | TODO |
F-TEM-08 | TODO |
F-RES-01 | IN-PROGRESS | Branch `f-res-ops-01-manual-reservations-tasks` merged via PR #4 `c42c225`; Vercel Prisma-generation fix merged via PR #5 `a847e38`. Tenant-scoped reservation/conflict schema, repository and service added. Evidence: local `npm run verify` passed on 2026-10-11 (lint, typecheck, checks, 18 unit files / 61 tests, build); CI runs `38145733738` and `38146068422` green. Protected Preview/staging deployment `dpl_954katAyDEWP9kQdEq8VJUdbC7Vw` ready at commit `a847e38`; readiness reported 11 migrations applied.
F-RES-02 | TODO |
F-RES-03 | TODO |
F-RES-04 | TODO |
F-RES-05 | DONE PR #13 808f30e | Airbnb transaction/payout CSV import merged with source identifiers, reservation matching and idempotency. Evidence: PR CI run `38165698273` green; local `npm run verify`, real-PostgreSQL integration and Playwright passed; independent protected Preview staging `dpl_3FyTpoF7qoHs8mVwmVEei6KBQfMy` verified Airbnb CSV import for reservation `HM-s7-chromium-1791745688593`.
F-RES-06 | TODO |
F-RES-07 | IN-PROGRESS | Manual reservation UI/action/service slice added. Evidence: `tests/unit/reservation-service.test.ts` > `denies reservation reads before reaching the repository`, `denies task reads before reaching the repository`, `denies manual reservation creation unless both reservation and task creation are allowed`, `validates that check-out is after check-in`; `tests/e2e/reservations-tasks.spec.ts` > `manual reservation to operations tasks journey` > `creates a manual reservation and displays generated arrival and checkout tasks` passed in CI for chromium and field-mobile. Protected Preview/staging browser verification on 2026-10-11 created `Staging Villa staging-s3-1791728260199` and confirmed 2 generated tasks. Keep IN-PROGRESS because direct/agency booking entry and full feature DoD remain broader than this S3 slice.
F-RES-08 | TODO |
F-RES-09 | IN-PROGRESS | Overlapping manual reservations create `reservation_conflict` rows with audit event. Evidence: CI `tests/integration/postgres-migration.test.ts` > `creates manual reservations with idempotent task generation, overlap detection, and tenant isolation` passed in run `38145733738`; local rerun blocked on 2026-10-11 because Docker Desktop Linux engine is unavailable. Command Center exception surfacing still pending.
F-RES-10 | TODO |
F-RES-11 | TODO |
F-RES-12 | TODO |
F-RES-13 | TODO |
F-RES-14 | TODO |
F-RES-15 | TODO |
F-RES-16 | TODO |
F-OPS-01 | IN-PROGRESS | Tenant-scoped `operation_task` model with state, priority, due date, reservation link, idempotency key and list view added. Evidence: CI `tests/e2e/reservations-tasks.spec.ts` > `creates a manual reservation and displays generated arrival and checkout tasks` passed in chromium and field-mobile; protected Preview/staging verification confirmed 2 tasks for `Staging Villa staging-s3-1791728260199`. Full task history still pending.
F-OPS-02 | IN-PROGRESS | Config-driven reservation task generation currently covers arrival preparation and checkout cleaning. Evidence: CI `tests/integration/postgres-migration.test.ts` > `creates manual reservations with idempotent task generation, overlap detection, and tenant isolation` passed in run `38145733738`; protected Preview/staging verification confirmed exactly one arrival preparation and one checkout cleaning task. Broader task type catalog pending.
F-OPS-03 | TODO |
F-OPS-04 | TODO |
F-OPS-05 | TODO |
F-OPS-06 | TODO |
F-OPS-07 | TODO |
F-OPS-08 | TODO |
F-OPS-09 | TODO |
F-OPS-10 | TODO |
F-AUT-01 | TODO |
F-AUT-02 | TODO |
F-AUT-03 | TODO |
F-AUT-04 | TODO |
F-AUT-05 | TODO |
F-AUT-06 | TODO |
F-AUT-07 | TODO |
F-FLD-01 | TODO |
F-FLD-02 | TODO |
F-FLD-03 | IN-PROGRESS | S4 online field slice on branch `f-fld-01-assigned-task-checklist`: authenticated field entry at `/app/field` lists current assigned work. Evidence: local `npm run verify` passed on 2026-10-11 (lint, typecheck, i18n, RTL CSS, boundaries, organization-id, ledger, audit, progress, 18 unit files / 62 tests, build). CI/staging pending.
F-FLD-04 | IN-PROGRESS | My Jobs view filters server-side to tasks assigned to the current user account. Evidence: `tests/integration/postgres-migration.test.ts` > `creates manual reservations with idempotent task generation, overlap detection, and tenant isolation` now asserts assigned tasks, field list, checklist RLS isolation and wrong-tenant completion rejection. Local integration rerun on 2026-10-11 blocked because Docker Desktop Linux engine was unavailable; CI/staging pending.
F-FLD-05 | IN-PROGRESS | Field job detail route `/app/field/[taskId]` opens only assigned tasks and returns not-found for unassigned/wrong-tenant access. Evidence: `tests/e2e/reservations-tasks.spec.ts` > `manual reservation to operations tasks journey` > `creates a manual reservation and displays generated arrival and checkout tasks` now opens an assigned field task. Local Playwright on 2026-10-11 passed 8 health/auth tests and skipped 10 DB-backed tests because no local database was configured; CI/staging pending.
F-FLD-06 | IN-PROGRESS | Checklist instance table, generated checklist items, large completion button, performer recording and `task.complete` audit event added. Evidence: `tests/unit/reservation-service.test.ts` > `denies assigned task completion before reaching the repository`; `tests/e2e/reservations-tasks.spec.ts` checks all checklist items and queues one assigned job offline before reconnect; `tests/integration/postgres-migration.test.ts` asserts `completedByUserAccountId`, checklist completion, completion idempotency key and `task.complete` audit. CI run `38150937692` green; protected Preview/staging verification completed task `01a12b94-2e96-7330-bb91-8b7076c4629f`.
F-FLD-07 | TODO |
F-FLD-08 | TODO |
F-FLD-09 | TODO |
F-FLD-10 | TODO |
F-FLD-11 | IN-PROGRESS | Operation queue slice merged via PR #8 `182cf4b`: versioned local field-task queue records `localId`, `userId`, `deviceId`, `clientOpId`, timestamp, operation payload and sync status; `POST /api/sync/push` persists `sync_op` with unique `(organization_id, device_id, client_op_id)` and returns APPLIED/DUPLICATE/CONFLICT/REJECTED per op. Evidence: local `npm run verify` passed on 2026-10-11 (19 unit files / 64 tests, build includes `/api/sync/push`); CI run `38150937692` green including real PostgreSQL integration and Playwright; protected Preview/staging deployment `dpl_HqaL3ijWKP4XZ5ihDc3Fc8A3YZMc` at commit `182cf4b` reported 13 migrations and verified offline queue -> reconnect -> sync for `Staging Offline Villa staging-offline-1791732469361-2bdc304c-13bc-488a-9d62-f1e36702f675`, task `01a12b94-2e96-7330-bb91-8b7076c4629f`, sync op `01a12b94-4eca-7157-957c-01659a6537d9`, audit `01a12b94-5549-7e54-83bb-3fa1b7ab830d`. Full F-FLD-11 remains broader because pull sync, IndexedDB day cache, quota and device hygiene remain pending.
F-FLD-12 | TODO |
F-FLD-13 | TODO |
F-FLD-14 | TODO |
F-FLD-15 | TODO |
F-FLD-16 | TODO |
F-FLD-17 | TODO |
F-FLD-18 | TODO |
F-FLD-19 | TODO |
F-FLD-20 | TODO |
F-FIN-01 | IN-PROGRESS | Branch `f-fnd-01-foundation-skeleton`: tenant-scoped ledger account schema added with org/code uniqueness and RLS. Full chart/templates, UI, PR/CI/staging incomplete.
F-FIN-02 | IN-PROGRESS | Branch `f-fnd-01-foundation-skeleton`: transaction + posting schema, append-only triggers, balance trigger, domain invariant tests, and migration check added. Real-Postgres verification blocked locally; full ledger workflows incomplete.
F-FIN-03 | TODO |
F-FIN-04 | TODO |
F-FIN-05 | TODO |
F-FIN-06 | TODO |
F-FIN-07 | TODO |
F-FIN-08 | TODO |
F-FIN-09 | TODO |
F-FIN-10 | DONE PR #13 808f30e | Airbnb settlement postings merged: 5,500.00 MAD gross, 300.00 MAD platform fee, 5,200.00 MAD expected payout, 5,150.00 MAD actual receipt and 50.00 MAD variance posted through append-only ledger transactions. Evidence: PR CI run `38165698273` green; staging `dpl_3FyTpoF7qoHs8mVwmVEei6KBQfMy` verified settlement `01a12c60-3cef-7355-ad4c-c3333c650088`, variance `01a12c60-4332-73a8-801d-2f16a3b2fb53`, transaction count `2`.
F-FIN-11 | TODO |
F-FIN-12 | TODO |
F-FIN-13 | IN-PROGRESS | S6 reservation accommodation revenue posting merged via PR #12 `543fee1`: authorized UI records 8000.00 MAD manual reservation revenue and creates balanced append-only owner revenue postings exactly once. Evidence: CI run `38158574875` green including real PostgreSQL and Playwright; protected Preview staging `dpl_GZgCD9jfoqFJXstKf9ux8dt2sm5L` verified `STAGING_S6_REVENUE_POSTED=true`.
F-FIN-14 | IN-PROGRESS | S6 applies the property's snapshotted commission rule to reservation accommodation revenue and posts owner net plus ALVILLAS commission without editable balances. Evidence: PR #12 `543fee1`; CI integration proves 8000.00 MAD gross -> 1600.00 MAD commission and 6400.00 MAD owner net, idempotency, reversal, tenant isolation and authorization; staging verified owner statement closing `6400.00`.
F-FIN-15 | TODO |
F-FIN-16 | TODO |
F-FIN-17 | TODO |
F-FIN-18 | IN-PROGRESS | S5 owner portal live balance merged via PR #10 `8996606`: owner ledger opening/credits/debits/closing derived from `OWNER_PAYABLE` postings only. S6 PR #12 `543fee1` posts reservation revenue into the same derived balance. Evidence: CI run `38158574875` green; protected Preview staging `dpl_GZgCD9jfoqFJXstKf9ux8dt2sm5L` verified owner statement closing `6400.00` after revenue posting.
F-FIN-19 | TODO |
F-FIN-20 | IN-PROGRESS | S5 shows remaining owner payable and posting-derived held-location breakdown without exposing internal bank account codes. S6 PR #12 `543fee1` adds reservation revenue/commission postings into that derived payable. Evidence: CI run `38158574875` green; protected Preview staging `dpl_GZgCD9jfoqFJXstKf9ux8dt2sm5L` verified `owner-money-held`/closing `6400.00`. Broader collected/allocated/used/reconciliation workflows pending.
F-FIN-21 | TODO |
F-FIN-22 | TODO |
F-FIN-23 | TODO |
F-FIN-24 | TODO |
F-FIN-25 | TODO |
F-FIN-26 | TODO |
F-FIN-27 | TODO |
F-FIN-28 | TODO |
F-FIN-29 | TODO |
F-FIN-30 | TODO |
F-FIN-31 | TODO |
F-FIN-32 | IN-PROGRESS | S7 merged reconciliation framework rows for Airbnb settlements and expected-vs-actual variance computation via PR #13 `808f30e`; staging `dpl_3FyTpoF7qoHs8mVwmVEei6KBQfMy` verified 5,200.00 expected vs 5,150.00 actual. Broader bank/laundry/staff/owner/inventory reconciliation pending.
F-FIN-33 | IN-PROGRESS | S7 merged open Variance Center rows and UI chain for Expected -> Actual -> Variance -> Reason -> Action on Airbnb settlements via PR #13 `808f30e`; staging verified 50.00 MAD reason `Bank fee` and action `Review payout`. Assignment/resolution/aging still pending.
F-FIN-34 | TODO |
F-FIN-35 | TODO |
F-FIN-36 | TODO |
F-FIN-37 | TODO |
F-FIN-38 | TODO |
F-FIN-39 | IN-PROGRESS | Branch `f-fnd-01-foundation-skeleton`: central serializer masks financial fields by data class. Full financial endpoint adoption and negative tests incomplete.
F-FIN-40 | TODO |
F-FIN-41 | TODO |
F-FIN-42 | IN-PROGRESS | S5 statement data generator added for period, opening, lines by bucket, credits/debits and closing from postings. S6 PR #12 `543fee1` feeds reservation revenue and commission lines into the statement. Evidence: CI run `38158574875` green; protected Preview staging `dpl_GZgCD9jfoqFJXstKf9ux8dt2sm5L` verified owner revenue and commission buckets with closing `6400.00`. PDF/CSV reuse pending.
F-DOC-01 | TODO |
F-DOC-02 | TODO |
F-DOC-03 | TODO |
F-DOC-04 | TODO |
F-DOC-05 | TODO |
F-DOC-06 | TODO |
F-DOC-07 | TODO |
F-DOC-08 | TODO |
F-DOC-09 | TODO |
F-DOC-10 | TODO |
F-DOC-11 | TODO |
F-CRM-01 | TODO |
F-CRM-02 | TODO |
F-CRM-03 | TODO |
F-CRM-04 | TODO |
F-CRM-05 | TODO |
F-CRM-06 | TODO |
F-CRM-07 | TODO |
F-CRM-08 | TODO |
F-ONB-01 | TODO |
F-ONB-02 | TODO |
F-ONB-03 | TODO |
F-ONB-04 | TODO |
F-ONB-05 | TODO |
F-ONB-06 | TODO |
F-ONB-07 | TODO |
F-GST-01 | TODO |
F-GST-02 | TODO |
F-GST-03 | TODO |
F-GST-04 | TODO |
F-GST-05 | TODO |
F-GST-06 | TODO |
F-GST-07 | TODO |
F-GST-08 | TODO |
F-GST-09 | TODO |
F-GST-10 | TODO |
F-GST-11 | TODO |
F-GST-12 | TODO |
F-GST-13 | TODO |
F-GST-14 | TODO |
F-GST-15 | TODO |
F-GST-16 | TODO |
F-SVC-01 | TODO |
F-SVC-02 | TODO |
F-SVC-03 | TODO |
F-SVC-04 | TODO |
F-SVC-05 | TODO |
F-SVC-06 | TODO |
F-SVC-07 | TODO |
F-SVC-08 | TODO |
F-INV-01 | TODO |
F-INV-02 | TODO |
F-INV-03 | TODO |
F-INV-04 | TODO |
F-INV-05 | TODO |
F-INV-06 | TODO |
F-INV-07 | TODO |
F-INV-08 | TODO |
F-INV-09 | TODO |
F-INV-10 | TODO |
F-LND-01 | TODO |
F-LND-02 | TODO |
F-LND-03 | TODO |
F-LND-04 | TODO |
F-LND-05 | TODO |
F-LND-06 | TODO |
F-LND-07 | TODO |
F-LND-08 | TODO |
F-LND-09 | TODO |
F-MNT-01 | TODO |
F-MNT-02 | TODO |
F-MNT-03 | TODO |
F-MNT-04 | TODO |
F-MNT-05 | TODO |
F-AST-01 | TODO |
F-AST-02 | TODO |
F-AST-03 | TODO |
F-AST-04 | TODO |
F-AST-05 | TODO |
F-SUP-01 | TODO |
F-SUP-02 | TODO |
F-SUP-03 | TODO |
F-SUP-04 | TODO |
F-SUP-05 | TODO |
F-OWN-01 | IN-PROGRESS | S5 owner portal entry `/app/owner-portal` lists only properties linked through tenant-scoped `owner_portal_access`. Evidence: PR #10 `8996606`, CI runs `38154596499`/`38154822044`; S6 protected Preview staging `dpl_GZgCD9jfoqFJXstKf9ux8dt2sm5L` verified cross-owner direct property statement access returns 404 after reservation revenue posting.
F-OWN-02 | TODO |
F-OWN-03 | IN-PROGRESS | S5 owner revenue, commission, expenses, services and payouts are visible as statement bucket totals derived from ledger postings. S6 PR #12 `543fee1` adds reservation-posted owner revenue and commission buckets. Evidence: CI run `38158574875` green; protected Preview staging `dpl_GZgCD9jfoqFJXstKf9ux8dt2sm5L` verified owner revenue and commission bucket totals after posting. Broader revenue/expense portal views pending.
F-OWN-04 | IN-PROGRESS | S5 owner money held by ALVILLAS appears as remaining payable from `OWNER_PAYABLE` closing balance. S6 PR #12 `543fee1` updates that payable from reservation revenue minus commission. Evidence: CI run `38158574875` green; protected Preview staging `dpl_GZgCD9jfoqFJXstKf9ux8dt2sm5L` verified owner statement closing `6400.00`. Full collected/allocated/used/paid drilldown pending.
F-OWN-05 | TODO |
F-OWN-06 | IN-PROGRESS | S5 monthly statement screen added with EN/FR display and ledger-derived opening/closing balances. S6 PR #12 `543fee1` verified the statement updates after an authorized reservation revenue posting. Evidence: CI run `38158574875` green; protected Preview staging `dpl_GZgCD9jfoqFJXstKf9ux8dt2sm5L` verified owner login -> property selection -> statement closing `6400.00`. PDF and CSV generation remain pending.
F-OWN-07 | TODO |
F-OWN-08 | TODO |
F-OWN-09 | TODO |
F-OWN-10 | TODO |
F-OWN-11 | TODO |
F-OWN-12 | TODO |
F-OWN-13 | TODO |
F-RPT-01 | TODO |
F-RPT-02 | TODO |
F-RPT-03 | TODO |
F-RPT-04 | TODO |
F-RPT-05 | TODO |
F-RPT-06 | TODO |
F-RPT-07 | TODO |
F-RPT-08 | TODO |
F-RPT-09 | TODO |
F-CMD-01 | TODO |
F-CMD-02 | TODO |
F-CMD-03 | TODO |
F-CMD-04 | TODO |
F-CMD-05 | TODO |
F-CMD-06 | TODO |
F-WEB-01 | TODO |
F-WEB-02 | TODO |
F-WEB-03 | TODO |
F-WEB-04 | TODO |
F-WEB-05 | TODO |
F-WEB-06 | TODO |
F-WEB-07 | TODO |
F-WEB-08 | TODO |
F-WEB-09 | TODO |
F-PER-01 | TODO |
F-PER-02 | TODO |
F-PER-03 | TODO |
F-PER-04 | TODO |
F-PER-05 | TODO |
F-PER-06 | TODO |
F-PER-07 | TODO |
F-PER-08 | TODO |
F-PER-09 | TODO |
F-PER-10 | TODO |
F-PER-11 | TODO |
F-SEC-01 | TODO |
F-SEC-02 | TODO |
F-SEC-03 | TODO |
F-SEC-04 | TODO |
F-SEC-05 | TODO |
F-SEC-06 | TODO |
F-SEC-07 | TODO |
F-PRF-01 | TODO |
F-PRF-02 | TODO |
F-PRF-03 | TODO |
F-PRF-04 | TODO |
F-OPR-01 | TODO |
F-OPR-02 | TODO |
F-OPR-03 | TODO |
F-OPR-04 | TODO |
F-OPR-05 | TODO |
F-DRC-01 | TODO |
F-DRC-02 | TODO |
F-DRC-03 | TODO |
F-DRC-04 | TODO |
F-QA-01 | TODO |
F-QA-02 | TODO |
F-QA-03 | TODO |
F-QA-04 | TODO |
F-QA-05 | TODO |
F-QA-06 | TODO |
