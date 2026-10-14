# PROGRESS.md - ALVILLAS OS

Format: one line per handbook feature ID as `F-ID | TODO | IN-PROGRESS | DONE <PR/commit evidence>`.

Archived checklist evidence remains in `docs/archive/`; it is not converted to feature `DONE` status unless the handbook Definition of Done is verified.

F-FND-01 | DONE PR #1 d1f1b81 | CI: `npm run lint`, `npm run typecheck`, `npm run build`, `npm run check:boundaries`, `tests/e2e/health.spec.ts`.
F-FND-02 | DONE PR #1 d1f1b81 | CI: `npm run check:organization-id`, `npm run check:schema-drift`, `tests/integration/postgres-migration.test.ts`.
F-FND-03 | DONE PR #1 d1f1b81 | CI: `tests/integration/postgres-migration.test.ts`, `npm run check:schema-drift`.
F-FND-04 | DONE PR #1 d1f1b81 | CI workflow ran `lint`, `typecheck`, policy checks, unit, integration, build and Playwright.
F-FND-05 | IN-PROGRESS | PR #15 merged 31bd0fb; PR CI run 38301501063 and final main checks run 38305433275 passed npm run lint, npm run typecheck, npm run check:schema-drift, npm run check:ledger, npm run check:audit, npm run check:progress, npm run test:unit, npm run test:integration, npm run rehearse:restore, npm run build, and npm run test:e2e. Exact blocker: deploy-staging stops before deployment because GitHub staging VERCEL_ORG_ID, VERCEL_PROJECT_ID and VERCEL_TOKEN are not configured; staging health/readiness cannot be verified.
F-FND-06 | IN-PROGRESS | PR #15 merged 31bd0fb; PR CI run 38301501063 and final main checks run 38305433275 passed npm run lint, npm run typecheck, npm run check:schema-drift, npm run check:ledger, npm run check:audit, npm run check:progress, npm run test:unit, npm run test:integration, npm run rehearse:restore, npm run build, and npm run test:e2e. Exact blocker: deploy-staging stops before deployment because GitHub staging VERCEL_ORG_ID, VERCEL_PROJECT_ID and VERCEL_TOKEN are not configured; staging health/readiness cannot be verified.
F-FND-07 | DONE PR #1 d1f1b81 | CI: `tests/unit/health.test.ts`, `tests/e2e/health.spec.ts`.
F-FND-08 | IN-PROGRESS | PR #15 merged 31bd0fb; CI checks run 38301501063 and final main checks run 38305433275 passed npm run lint, npm run typecheck, policy checks, npm run test:unit, npm run test:integration, npm run rehearse:restore, npm run build, and npm run test:e2e. Exact blocker: owner/provider credentials and staging provider projects are not configured or verifiable yet; staging deploy is also blocked by missing VERCEL_ORG_ID, VERCEL_PROJECT_ID and VERCEL_TOKEN.
F-FND-09 | IN-PROGRESS | PR #15 merged 31bd0fb; CI checks run 38301501063 and final main checks run 38305433275 passed npm run lint, npm run typecheck, policy checks, npm run test:unit, npm run test:integration, npm run rehearse:restore, npm run build, and npm run test:e2e. Exact blocker: owner/provider credentials and staging provider projects are not configured or verifiable yet; staging deploy is also blocked by missing VERCEL_ORG_ID, VERCEL_PROJECT_ID and VERCEL_TOKEN.
F-FND-10 | IN-PROGRESS | PR #15 merged 31bd0fb; CI checks run 38301501063 and final main checks run 38305433275 passed npm run lint, npm run typecheck, policy checks, npm run test:unit, npm run test:integration, npm run rehearse:restore, npm run build, and npm run test:e2e. Exact blocker: owner/provider credentials and staging provider projects are not configured or verifiable yet; staging deploy is also blocked by missing VERCEL_ORG_ID, VERCEL_PROJECT_ID and VERCEL_TOKEN.
F-FND-11 | DONE PR #1 d1f1b81 | CI: `tests/unit/money.test.ts`, `npm run check:ledger`, `tests/integration/postgres-migration.test.ts`.
F-FND-12 | DONE PR #1 d1f1b81 | CI: `tests/unit/reference-number.test.ts`, `tests/integration/postgres-migration.test.ts`.
F-FND-13 | IN-PROGRESS | First-admin bootstrap remains covered by tests/unit/bootstrap-admin.test.ts. Evidence: PR #15 merged 31bd0fb; CI checks run 38301501063 and final main checks run 38305433275 passed npm run test:unit, npm run test:integration, npm run rehearse:restore, npm run build, and npm run test:e2e. Exact blocker: staging bootstrap/auth verification cannot run until GitHub staging VERCEL_ORG_ID, VERCEL_PROJECT_ID and VERCEL_TOKEN are configured.
F-FND-14 | IN-PROGRESS | Demo seed is production-blocked and deterministic for the demo organization, covered by tests/unit/demo-seed.test.ts. Exact blocker: complete deterministic demo data for owners, properties, reservations, tasks, ledger and EN/FR paths is not built.
F-FND-15 | IN-PROGRESS | Executable backup/restore rehearsal is in CI. Evidence: PR #15 merged 31bd0fb; CI run 38301501063 and final main checks run 38305433275 passed npm run rehearse:restore after applying 18 PostgreSQL migrations. Exact blocker: independent staging/managed-PostgreSQL restore rehearsal cannot be verified until staging credentials are configured; production restore remains owner-approved only.
F-FND-16 | IN-PROGRESS | Postgres RateLimiter and login adoption are covered by tests/unit/rate-limiter.test.ts and tests/e2e/auth.spec.ts. Evidence: PR #15 merged 31bd0fb; final main checks run 38305433275 passed npm run test:unit and npm run test:e2e. Exact blocker: DEC-22 adoption is incomplete for future endpoint features including public lead form, Guest Hub links and exports.
F-IDN-01 | IN-PROGRESS | Identity schema models person/account credentials/session/device/invitation/roles and invitation creates tenant-scoped Person. Evidence: PR #16 merged a9aa0eb after PR #15; PR CI run 38304438583 and main checks run 38304909119 passed npm run test:integration and npm run test:e2e including tests/e2e/auth.spec.ts and tests/e2e/identity.spec.ts. Local PostgreSQL npm run test:integration passed 11 tests against 18 migrations; local identity Playwright verified the main authorization lifecycle with tests/e2e/identity.spec.ts. Exact blocker: staging deploy/health/readiness cannot be verified until GitHub staging VERCEL_ORG_ID, VERCEL_PROJECT_ID and VERCEL_TOKEN are configured. Full profile and duplicate/contact management UI remain incomplete.
F-IDN-02 | IN-PROGRESS | UserAccount supports PASSWORD, PIN, TOTP, RECOVERY_CODE and PASSKEY credentials through Auth.js and argon2id. Evidence: PR #16 merged a9aa0eb after PR #15; PR CI run 38304438583 and main checks run 38304909119 passed npm run test:integration and npm run test:e2e including tests/e2e/auth.spec.ts and tests/e2e/identity.spec.ts. Local PostgreSQL npm run test:integration passed 11 tests against 18 migrations; local identity Playwright verified the main authorization lifecycle with tests/e2e/identity.spec.ts. Exact blocker: staging deploy/health/readiness cannot be verified until GitHub staging VERCEL_ORG_ID, VERCEL_PROJECT_ID and VERCEL_TOKEN are configured. Remaining work is broader credential lifecycle polish across future surfaces.
F-IDN-03 | IN-PROGRESS | Phone plus PIN login for field users is implemented with argon2id, rate limiting, stable device id and suspended-account denial. Evidence: PR #16 merged a9aa0eb after PR #15; PR CI run 38304438583 and main checks run 38304909119 passed npm run test:integration and npm run test:e2e including tests/e2e/auth.spec.ts and tests/e2e/identity.spec.ts. Local PostgreSQL npm run test:integration passed 11 tests against 18 migrations; local identity Playwright verified the main authorization lifecycle with tests/e2e/identity.spec.ts. Exact blocker: staging deploy/health/readiness cannot be verified until GitHub staging VERCEL_ORG_ID, VERCEL_PROJECT_ID and VERCEL_TOKEN are configured. Future endpoint adoption remains tied to later modules.
F-IDN-04 | IN-PROGRESS | Invitation flow creates person, role/scope assignment, one-time code, phone verification, PIN/password activation and audit. Evidence: PR #16 merged a9aa0eb after PR #15; PR CI run 38304438583 and main checks run 38304909119 passed npm run test:integration and npm run test:e2e including tests/e2e/auth.spec.ts and tests/e2e/identity.spec.ts. Local PostgreSQL npm run test:integration passed 11 tests against 18 migrations; local identity Playwright verified the main authorization lifecycle with tests/e2e/identity.spec.ts. Exact blocker: staging deploy/health/readiness cannot be verified until GitHub staging VERCEL_ORG_ID, VERCEL_PROJECT_ID and VERCEL_TOKEN are configured. Broader invite delivery/provider UX remains incomplete.
F-IDN-05 | IN-PROGRESS | Invitation code security uses random hashed codes, expiry, single use, rate limit, phone binding, invalid reuse denial and audit. Evidence: PR #16 merged a9aa0eb after PR #15; PR CI run 38304438583 and main checks run 38304909119 passed npm run test:integration and npm run test:e2e including tests/e2e/auth.spec.ts and tests/e2e/identity.spec.ts. Local PostgreSQL npm run test:integration passed 11 tests against 18 migrations; local identity Playwright verified the main authorization lifecycle with tests/e2e/identity.spec.ts. Exact blocker: staging deploy/health/readiness cannot be verified until GitHub staging VERCEL_ORG_ID, VERCEL_PROJECT_ID and VERCEL_TOKEN are configured. Delivery/provider hardening remains incomplete.
F-IDN-06 | IN-PROGRESS | Admin/finance MFA policy, TOTP setup, recovery codes and WebAuthn passkey registration are implemented for privileged accounts. Evidence: PR #16 merged a9aa0eb after PR #15; PR CI run 38304438583 and main checks run 38304909119 passed npm run test:integration and npm run test:e2e including tests/e2e/auth.spec.ts and tests/e2e/identity.spec.ts. Local PostgreSQL npm run test:integration passed 11 tests against 18 migrations; local identity Playwright verified the main authorization lifecycle with tests/e2e/identity.spec.ts. Exact blocker: staging deploy/health/readiness cannot be verified until GitHub staging VERCEL_ORG_ID, VERCEL_PROJECT_ID and VERCEL_TOKEN are configured. Broader MFA policy surfaces and staging verification remain incomplete.
F-IDN-07 | IN-PROGRESS | Owner role invitations can create password/PIN accounts and the shared passkey/MFA credential system supports optional MFA. Evidence: PR #16 merged a9aa0eb after PR #15; PR CI run 38304438583 and main checks run 38304909119 passed npm run test:integration and npm run test:e2e including tests/e2e/auth.spec.ts and tests/e2e/identity.spec.ts. Local PostgreSQL npm run test:integration passed 11 tests against 18 migrations; local identity Playwright verified the main authorization lifecycle with tests/e2e/identity.spec.ts. Exact blocker: staging deploy/health/readiness cannot be verified until GitHub staging VERCEL_ORG_ID, VERCEL_PROJECT_ID and VERCEL_TOKEN are configured. Owner-specific account UX remains broader than this slice.
F-IDN-08 | IN-PROGRESS | Auth.js JWT sessions link to tenant auth_session/auth_device records with secure cookie settings, session validation and revoke service hooks. Evidence: PR #16 merged a9aa0eb after PR #15; PR CI run 38304438583 and main checks run 38304909119 passed npm run test:integration and npm run test:e2e including tests/e2e/auth.spec.ts and tests/e2e/identity.spec.ts. Local PostgreSQL npm run test:integration passed 11 tests against 18 migrations; local identity Playwright verified the main authorization lifecycle with tests/e2e/identity.spec.ts. Exact blocker: staging deploy/health/readiness cannot be verified until GitHub staging VERCEL_ORG_ID, VERCEL_PROJECT_ID and VERCEL_TOKEN are configured. Remote revoke UI/list details remain incomplete.
F-IDN-09 | IN-PROGRESS | Recovery code issue/recover flow and MFA recovery codes are implemented with one-time hashed credentials. Evidence: PR #16 merged a9aa0eb after PR #15; PR CI run 38304438583 and main checks run 38304909119 passed npm run test:integration and npm run test:e2e including tests/e2e/auth.spec.ts and tests/e2e/identity.spec.ts. Local PostgreSQL npm run test:integration passed 11 tests against 18 migrations; local identity Playwright verified the main authorization lifecycle with tests/e2e/identity.spec.ts. Exact blocker: staging deploy/health/readiness cannot be verified until GitHub staging VERCEL_ORG_ID, VERCEL_PROJECT_ID and VERCEL_TOKEN are configured. Supervisor PIN reset and email delivery provider remain incomplete.
F-IDN-10 | IN-PROGRESS | Account suspend/reactivate revokes sessions and increments sessionVersion, with denied login coverage. Evidence: PR #16 merged a9aa0eb after PR #15; PR CI run 38304438583 and main checks run 38304909119 passed npm run test:integration and npm run test:e2e including tests/e2e/auth.spec.ts and tests/e2e/identity.spec.ts. Local PostgreSQL npm run test:integration passed 11 tests against 18 migrations; local identity Playwright verified the main authorization lifecycle with tests/e2e/identity.spec.ts. Exact blocker: staging deploy/health/readiness cannot be verified until GitHub staging VERCEL_ORG_ID, VERCEL_PROJECT_ID and VERCEL_TOKEN are configured. Deactivate/offboard and assignment/device revocation remain incomplete.
F-IDN-11 | IN-PROGRESS | Stable device_id cookie and auth_device registration on login are implemented for field/offline identity. Evidence: PR #16 merged a9aa0eb after PR #15; PR CI run 38304438583 and main checks run 38304909119 passed npm run test:integration and npm run test:e2e including tests/e2e/auth.spec.ts and tests/e2e/identity.spec.ts. Local PostgreSQL npm run test:integration passed 11 tests against 18 migrations; local identity Playwright verified the main authorization lifecycle with tests/e2e/identity.spec.ts. Exact blocker: staging deploy/health/readiness cannot be verified until GitHub staging VERCEL_ORG_ID, VERCEL_PROJECT_ID and VERCEL_TOKEN are configured. Device pairing/management UX remains incomplete.
F-AUZ-01 | IN-PROGRESS | Standard role catalog is centralized, seeded and shown in the Identity UI; custom-role storage remains compatible. Evidence: PR #17 merged e88d4a4 after PR #16; PR CI run 38304971525 and final main checks run 38305433275 passed npm run test:integration and npm run test:e2e including tests/e2e/identity.spec.ts. Local npm run test:unit -- tests/unit/authorize.test.ts tests/unit/permission-matrix.generated.test.ts tests/unit/present.test.ts passed 25 files and 10397 tests; local npm run test:integration passed 11 tests against 18 migrations. Exact blocker: staging deploy/health/readiness cannot be verified until GitHub staging VERCEL_ORG_ID, VERCEL_PROJECT_ID and VERCEL_TOKEN are configured. Remaining blocker: custom role UX hardening and staging evidence.
F-AUZ-02 | IN-PROGRESS | Permission catalog is generated from canonical resources/actions and seeded per tenant with descriptions. Evidence: PR #17 merged e88d4a4 after PR #16; PR CI run 38304971525 and final main checks run 38305433275 passed npm run test:integration and npm run test:e2e including tests/e2e/identity.spec.ts. Local npm run test:unit -- tests/unit/authorize.test.ts tests/unit/permission-matrix.generated.test.ts tests/unit/present.test.ts passed 25 files and 10397 tests; local npm run test:integration passed 11 tests against 18 migrations. Exact blocker: staging deploy/health/readiness cannot be verified until GitHub staging VERCEL_ORG_ID, VERCEL_PROJECT_ID and VERCEL_TOKEN are configured. Remaining blocker: staging evidence.
F-AUZ-03 | IN-PROGRESS | Role assignments carry scope, conditions, validity and compensation reference into AuthContext. Evidence: PR #17 merged e88d4a4 after PR #16; PR CI run 38304971525 and final main checks run 38305433275 passed npm run test:integration and npm run test:e2e including tests/e2e/identity.spec.ts. Local npm run test:unit -- tests/unit/authorize.test.ts tests/unit/permission-matrix.generated.test.ts tests/unit/present.test.ts passed 25 files and 10397 tests; local npm run test:integration passed 11 tests against 18 migrations. Exact blocker: staging deploy/health/readiness cannot be verified until GitHub staging VERCEL_ORG_ID, VERCEL_PROJECT_ID and VERCEL_TOKEN are configured. Remaining blocker: complete admin assignment workflow breadth.
F-AUZ-04 | IN-PROGRESS | AuthContext supports multiple active assignments and merges their permissions/scopes without treating role as data access. Evidence: PR #17 merged e88d4a4 after PR #16; PR CI run 38304971525 and final main checks run 38305433275 passed npm run test:integration and npm run test:e2e including tests/e2e/identity.spec.ts. Local npm run test:unit -- tests/unit/authorize.test.ts tests/unit/permission-matrix.generated.test.ts tests/unit/present.test.ts passed 25 files and 10397 tests; local npm run test:integration passed 11 tests against 18 migrations. Exact blocker: staging deploy/health/readiness cannot be verified until GitHub staging VERCEL_ORG_ID, VERCEL_PROJECT_ID and VERCEL_TOKEN are configured. Remaining blocker: complete multi-assignment UI breadth.
F-AUZ-05 | IN-PROGRESS | Scope hierarchy covers organization, region, city, property, owner, reservation, job, service, financial_record, wallet and field_team with DB checks. Evidence: PR #17 merged e88d4a4 after PR #16; PR CI run 38304971525 and final main checks run 38305433275 passed npm run test:integration and npm run test:e2e including tests/e2e/identity.spec.ts. Local npm run test:unit -- tests/unit/authorize.test.ts tests/unit/permission-matrix.generated.test.ts tests/unit/present.test.ts passed 25 files and 10397 tests; local npm run test:integration passed 11 tests against 18 migrations. Exact blocker: staging deploy/health/readiness cannot be verified until GitHub staging VERCEL_ORG_ID, VERCEL_PROJECT_ID and VERCEL_TOKEN are configured. Remaining blocker: every future business module must adopt scoped repository filters.
F-AUZ-06 | IN-PROGRESS | authorize() is assignment-aware, deny-by-default, condition-aware and adopted in current core/reservation paths. Evidence: PR #17 merged e88d4a4 after PR #16; PR CI run 38304971525 and final main checks run 38305433275 passed npm run test:integration and npm run test:e2e including tests/e2e/identity.spec.ts. Local npm run test:unit -- tests/unit/authorize.test.ts tests/unit/permission-matrix.generated.test.ts tests/unit/present.test.ts passed 25 files and 10397 tests; local npm run test:integration passed 11 tests against 18 migrations. Exact blocker: staging deploy/health/readiness cannot be verified until GitHub staging VERCEL_ORG_ID, VERCEL_PROJECT_ID and VERCEL_TOKEN are configured. Remaining blocker: not every future server action, API, job and repository entry point exists or is covered yet.
F-AUZ-07 | IN-PROGRESS | ABAC conditions for assigned-to-me, status, max amount and time window are parsed and enforced. Evidence: PR #17 merged e88d4a4 after PR #16; PR CI run 38304971525 and final main checks run 38305433275 passed npm run test:integration and npm run test:e2e including tests/e2e/identity.spec.ts. Local npm run test:unit -- tests/unit/authorize.test.ts tests/unit/permission-matrix.generated.test.ts tests/unit/present.test.ts passed 25 files and 10397 tests; local npm run test:integration passed 11 tests against 18 migrations. Exact blocker: staging deploy/health/readiness cannot be verified until GitHub staging VERCEL_ORG_ID, VERCEL_PROJECT_ID and VERCEL_TOKEN are configured. Remaining blocker: rule authoring UI and full future module adoption.
F-AUZ-08 | IN-PROGRESS | Field policy catalog/table and present() required-permission masking cover financial and sensitive fields. Evidence: PR #17 merged e88d4a4 after PR #16; PR CI run 38304971525 and final main checks run 38305433275 passed npm run test:integration and npm run test:e2e including tests/e2e/identity.spec.ts. Local npm run test:unit -- tests/unit/authorize.test.ts tests/unit/permission-matrix.generated.test.ts tests/unit/present.test.ts passed 25 files and 10397 tests; local npm run test:integration passed 11 tests against 18 migrations. Exact blocker: staging deploy/health/readiness cannot be verified until GitHub staging VERCEL_ORG_ID, VERCEL_PROJECT_ID and VERCEL_TOKEN are configured. Remaining blocker: every future endpoint serializer has not yet adopted field policies.
F-AUZ-09 | IN-PROGRESS | Real PostgreSQL tests cover scoped authorization, cross-tenant denial, simulator immutability and field masking from persisted assignments. Evidence: PR #17 merged e88d4a4 after PR #16; PR CI run 38304971525 and final main checks run 38305433275 passed npm run test:integration and npm run test:e2e including tests/e2e/identity.spec.ts. Local npm run test:unit -- tests/unit/authorize.test.ts tests/unit/permission-matrix.generated.test.ts tests/unit/present.test.ts passed 25 files and 10397 tests; local npm run test:integration passed 11 tests against 18 migrations. Exact blocker: staging deploy/health/readiness cannot be verified until GitHub staging VERCEL_ORG_ID, VERCEL_PROJECT_ID and VERCEL_TOKEN are configured. Remaining blocker: exhaustive coverage for every future business table/repository.
F-AUZ-10 | IN-PROGRESS | Owner/property scoping is preserved through owner portal and core property filtering while role catalog includes owner representative. Evidence: PR #17 merged e88d4a4 after PR #16; PR CI run 38304971525 and final main checks run 38305433275 passed npm run test:integration and npm run test:e2e including tests/e2e/identity.spec.ts. Local npm run test:unit -- tests/unit/authorize.test.ts tests/unit/permission-matrix.generated.test.ts tests/unit/present.test.ts passed 25 files and 10397 tests; local npm run test:integration passed 11 tests against 18 migrations. Exact blocker: staging deploy/health/readiness cannot be verified until GitHub staging VERCEL_ORG_ID, VERCEL_PROJECT_ID and VERCEL_TOKEN are configured. Remaining blocker: owner delegation management workflow.
F-AUZ-11 | IN-PROGRESS | Read-only permission simulator service and Identity UI panel show allowed/denied scenarios without mutating assignments. Evidence: PR #17 merged e88d4a4 after PR #16; PR CI run 38304971525 and final main checks run 38305433275 passed npm run test:integration and npm run test:e2e including tests/e2e/identity.spec.ts. Local npm run test:unit -- tests/unit/authorize.test.ts tests/unit/permission-matrix.generated.test.ts tests/unit/present.test.ts passed 25 files and 10397 tests; local npm run test:integration passed 11 tests against 18 migrations. Exact blocker: staging deploy/health/readiness cannot be verified until GitHub staging VERCEL_ORG_ID, VERCEL_PROJECT_ID and VERCEL_TOKEN are configured. Remaining blocker: full admin scenario builder.
F-AUZ-12 | IN-PROGRESS | Generated permission matrix tests prove standard role expectations including co-host denial of revenue, other properties and wallets. Evidence: PR #17 merged e88d4a4 after PR #16; PR CI run 38304971525 and final main checks run 38305433275 passed npm run test:integration and npm run test:e2e including tests/e2e/identity.spec.ts. Local npm run test:unit -- tests/unit/authorize.test.ts tests/unit/permission-matrix.generated.test.ts tests/unit/present.test.ts passed 25 files and 10397 tests; local npm run test:integration passed 11 tests against 18 migrations. Exact blocker: staging deploy/health/readiness cannot be verified until GitHub staging VERCEL_ORG_ID, VERCEL_PROJECT_ID and VERCEL_TOKEN are configured. Remaining blocker: matrix is not yet exhaustive across every role/resource/action/scope.
F-AUD-01 | DONE | Audit log append-only protection is integrated. Evidence: PR #18 merged as 2ac9640 after PR CI run 38364136853 passed; post-merge GitHub checks job in run 38365036232 passed. Local evidence: npm run test:integration passed 13 PostgreSQL tests including append-only update/delete denial. Staging evidence: protected preview dpl_8KmMrjXsWKo6Ki8UBh1G2rZBmaXH passed tests/e2e/audit.spec.ts chromium with 2 tests.
F-AUD-02 | DONE | Required audit event-family coverage is integrated. Evidence: PR #18 merged as 2ac9640 after PR CI run 38364136853 passed; local npm run test:integration passed 13 PostgreSQL tests including the section 61 required event-family catalog coverage. Staging evidence: protected preview dpl_8KmMrjXsWKo6Ki8UBh1G2rZBmaXH passed AUD Playwright verification.
F-AUD-03 | DONE | Audit writer stores who, what, when, where, before, after and reason, with sensitive payload redaction. Evidence: PR #18 merged as 2ac9640 after CI run 38364136853 passed; local PostgreSQL tests passed 13 tests; staging tests/e2e/audit.spec.ts on protected preview dpl_8KmMrjXsWKo6Ki8UBh1G2rZBmaXH verified audit viewer data and CSV redaction with secret values absent.
F-AUD-04 | DONE | Audit writer guards are integrated for reason-required and security/account-access events. Evidence: PR #18 merged as 2ac9640 after CI run 38364136853 passed; local unit and PostgreSQL coverage stayed green, including 13 PostgreSQL tests; post-merge GitHub checks job in run 38365036232 passed. Staging AUD verification passed on dpl_8KmMrjXsWKo6Ki8UBh1G2rZBmaXH.
F-AUD-05 | DONE | Permission-gated audit viewer, filtering and CSV export are integrated. Evidence: PR #18 merged as 2ac9640 after CI run 38364136853 passed; local DATABASE_URL-backed Playwright suite passed 32 tests. Staging evidence: protected preview dpl_8KmMrjXsWKo6Ki8UBh1G2rZBmaXH passed tests/e2e/audit.spec.ts chromium: admin views, filters and exports audit history; unauthorized users are denied viewer and export with 403.
F-I18-01 | DONE | Integrated in PR #19, merged to main as 92d2fba after PR CI run 38383398827 and main CI run 38384048635 passed lint, typecheck, check:i18n, check:rtl-css, check:progress, unit (26 files/10975 tests), integration (13 real-PostgreSQL tests/18 migrations), rehearse:restore, build and e2e. Staging evidence: preview dpl_B8YUMayr4qntaoEmh3LwjZk49tJx at https://the-alvillas-ocswdi4s8-nadirlagnadi-6231s-projects.vercel.app returned health/readiness/version ok for 92d2fba; protected-preview browser check passed EN/FR switching, Arabic RTL, saved preferred language redirect; localized owner-statement EN/FR email/PDF contracts passed. Staging credential gate evidence: run 38384048635 deploy-staging detected absent credentials and skipped install/deploy/smoke steps without emitting a deployment URL. Scope unchanged: all 355 features remain required.
F-I18-02 | DONE | Integrated in PR #19, merged to main as 92d2fba after PR CI run 38383398827 and main CI run 38384048635 passed lint, typecheck, check:i18n, check:rtl-css, check:progress, unit (26 files/10975 tests), integration (13 real-PostgreSQL tests/18 migrations), rehearse:restore, build and e2e. Staging evidence: preview dpl_B8YUMayr4qntaoEmh3LwjZk49tJx at https://the-alvillas-ocswdi4s8-nadirlagnadi-6231s-projects.vercel.app returned health/readiness/version ok for 92d2fba; protected-preview browser check passed EN/FR switching, Arabic RTL, saved preferred language redirect; localized owner-statement EN/FR email/PDF contracts passed. Staging credential gate evidence: run 38384048635 deploy-staging detected absent credentials and skipped install/deploy/smoke steps without emitting a deployment URL. Scope unchanged: all 355 features remain required.
F-I18-03 | DONE | Integrated in PR #19, merged to main as 92d2fba after PR CI run 38383398827 and main CI run 38384048635 passed lint, typecheck, check:i18n, check:rtl-css, check:progress, unit (26 files/10975 tests), integration (13 real-PostgreSQL tests/18 migrations), rehearse:restore, build and e2e. Staging evidence: preview dpl_B8YUMayr4qntaoEmh3LwjZk49tJx at https://the-alvillas-ocswdi4s8-nadirlagnadi-6231s-projects.vercel.app returned health/readiness/version ok for 92d2fba; protected-preview browser check passed EN/FR switching, Arabic RTL, saved preferred language redirect; localized owner-statement EN/FR email/PDF contracts passed. Staging credential gate evidence: run 38384048635 deploy-staging detected absent credentials and skipped install/deploy/smoke steps without emitting a deployment URL. Scope unchanged: all 355 features remain required.
F-I18-04 | DONE | Integrated in PR #19, merged to main as 92d2fba after PR CI run 38383398827 and main CI run 38384048635 passed lint, typecheck, check:i18n, check:rtl-css, check:progress, unit (26 files/10975 tests), integration (13 real-PostgreSQL tests/18 migrations), rehearse:restore, build and e2e. Staging evidence: preview dpl_B8YUMayr4qntaoEmh3LwjZk49tJx at https://the-alvillas-ocswdi4s8-nadirlagnadi-6231s-projects.vercel.app returned health/readiness/version ok for 92d2fba; protected-preview browser check passed EN/FR switching, Arabic RTL, saved preferred language redirect; localized owner-statement EN/FR email/PDF contracts passed. Staging credential gate evidence: run 38384048635 deploy-staging detected absent credentials and skipped install/deploy/smoke steps without emitting a deployment URL. Scope unchanged: all 355 features remain required.
F-I18-05 | DONE | Integrated in PR #19, merged to main as 92d2fba after PR CI run 38383398827 and main CI run 38384048635 passed lint, typecheck, check:i18n, check:rtl-css, check:progress, unit (26 files/10975 tests), integration (13 real-PostgreSQL tests/18 migrations), rehearse:restore, build and e2e. Staging evidence: preview dpl_B8YUMayr4qntaoEmh3LwjZk49tJx at https://the-alvillas-ocswdi4s8-nadirlagnadi-6231s-projects.vercel.app returned health/readiness/version ok for 92d2fba; protected-preview browser check passed EN/FR switching, Arabic RTL, saved preferred language redirect; localized owner-statement EN/FR email/PDF contracts passed. Staging credential gate evidence: run 38384048635 deploy-staging detected absent credentials and skipped install/deploy/smoke steps without emitting a deployment URL. Scope unchanged: all 355 features remain required.
F-I18-06 | DONE | Integrated in PR #19, merged to main as 92d2fba after PR CI run 38383398827 and main CI run 38384048635 passed lint, typecheck, check:i18n, check:rtl-css, check:progress, unit (26 files/10975 tests), integration (13 real-PostgreSQL tests/18 migrations), rehearse:restore, build and e2e. Staging evidence: preview dpl_B8YUMayr4qntaoEmh3LwjZk49tJx at https://the-alvillas-ocswdi4s8-nadirlagnadi-6231s-projects.vercel.app returned health/readiness/version ok for 92d2fba; protected-preview browser check passed EN/FR switching, Arabic RTL, saved preferred language redirect; localized owner-statement EN/FR email/PDF contracts passed. Staging credential gate evidence: run 38384048635 deploy-staging detected absent credentials and skipped install/deploy/smoke steps without emitting a deployment URL. Scope unchanged: all 355 features remain required.
F-I18-07 | DONE | Integrated in PR #19, merged to main as 92d2fba after PR CI run 38383398827 and main CI run 38384048635 passed lint, typecheck, check:i18n, check:rtl-css, check:progress, unit (26 files/10975 tests), integration (13 real-PostgreSQL tests/18 migrations), rehearse:restore, build and e2e. Staging evidence: preview dpl_B8YUMayr4qntaoEmh3LwjZk49tJx at https://the-alvillas-ocswdi4s8-nadirlagnadi-6231s-projects.vercel.app returned health/readiness/version ok for 92d2fba; protected-preview browser check passed EN/FR switching, Arabic RTL, saved preferred language redirect; localized owner-statement EN/FR email/PDF contracts passed. Staging credential gate evidence: run 38384048635 deploy-staging detected absent credentials and skipped install/deploy/smoke steps without emitting a deployment URL. Scope unchanged: all 355 features remain required.
F-DSN-01 | DONE | PR #20/main CI run 38410221535 passed lint/typecheck/i18n/RTL/design-system/progress/unit/integration/restore/build/e2e. Current branch local evidence: npm run verify passed with 27 unit files/10979 tests and production build; npm run test:integration passed 13 real-PostgreSQL tests/18 migrations; DATABASE_URL-backed npm run test:e2e passed 38/38. Staging acceptance: independent protected preview dpl_ABBnmQjjfdkeWJATFPrFi94cGDmn for the-alvillas-os used Neon spring-credit-88181064 neondb with 18 migrations; pre-change snapshot alvillas-os-staging-before-admin-reset-20261013-085322.dump created; admin.staging@alvillas.test reset through existing bootstrap, same account/person/admin role/business counts preserved, MFA required, sessions revoked to 0 after verifier; protected-browser check verified secure session cookie, MFA, logout, EN/FR/RTL, 360px, keyboard, Admin/Manager/Field routes and authenticated DSN board Owner/Guest shells; health/readiness ok and temporary Vercel bypass revoked. Scope unchanged: all 355 features remain required.
F-DSN-02 | DONE | PR #20/main CI run 38410221535 passed lint/typecheck/i18n/RTL/design-system/progress/unit/integration/restore/build/e2e. Current branch local evidence: npm run verify passed with 27 unit files/10979 tests and production build; npm run test:integration passed 13 real-PostgreSQL tests/18 migrations; DATABASE_URL-backed npm run test:e2e passed 38/38. Staging acceptance: independent protected preview dpl_ABBnmQjjfdkeWJATFPrFi94cGDmn for the-alvillas-os used Neon spring-credit-88181064 neondb with 18 migrations; pre-change snapshot alvillas-os-staging-before-admin-reset-20261013-085322.dump created; admin.staging@alvillas.test reset through existing bootstrap, same account/person/admin role/business counts preserved, MFA required, sessions revoked to 0 after verifier; protected-browser check verified secure session cookie, MFA, logout, EN/FR/RTL, 360px, keyboard, Admin/Manager/Field routes and authenticated DSN board Owner/Guest shells; health/readiness ok and temporary Vercel bypass revoked. Scope unchanged: all 355 features remain required.
F-DSN-03 | DONE | PR #20/main CI run 38410221535 passed lint/typecheck/i18n/RTL/design-system/progress/unit/integration/restore/build/e2e. Current branch local evidence: npm run verify passed with 27 unit files/10979 tests and production build; npm run test:integration passed 13 real-PostgreSQL tests/18 migrations; DATABASE_URL-backed npm run test:e2e passed 38/38. Staging acceptance: independent protected preview dpl_ABBnmQjjfdkeWJATFPrFi94cGDmn for the-alvillas-os used Neon spring-credit-88181064 neondb with 18 migrations; pre-change snapshot alvillas-os-staging-before-admin-reset-20261013-085322.dump created; admin.staging@alvillas.test reset through existing bootstrap, same account/person/admin role/business counts preserved, MFA required, sessions revoked to 0 after verifier; protected-browser check verified secure session cookie, MFA, logout, EN/FR/RTL, 360px, keyboard, Admin/Manager/Field routes and authenticated DSN board Owner/Guest shells; health/readiness ok and temporary Vercel bypass revoked. Scope unchanged: all 355 features remain required.
F-DSN-04 | DONE | PR #20/main CI run 38410221535 passed lint/typecheck/i18n/RTL/design-system/progress/unit/integration/restore/build/e2e. Current branch local evidence: npm run verify passed with 27 unit files/10979 tests and production build; npm run test:integration passed 13 real-PostgreSQL tests/18 migrations; DATABASE_URL-backed npm run test:e2e passed 38/38. Staging acceptance: independent protected preview dpl_ABBnmQjjfdkeWJATFPrFi94cGDmn for the-alvillas-os used Neon spring-credit-88181064 neondb with 18 migrations; pre-change snapshot alvillas-os-staging-before-admin-reset-20261013-085322.dump created; admin.staging@alvillas.test reset through existing bootstrap, same account/person/admin role/business counts preserved, MFA required, sessions revoked to 0 after verifier; protected-browser check verified secure session cookie, MFA, logout, EN/FR/RTL, 360px, keyboard, Admin/Manager/Field routes and authenticated DSN board Owner/Guest shells; health/readiness ok and temporary Vercel bypass revoked. Scope unchanged: all 355 features remain required.
F-DSN-05 | DONE | PR #20/main CI run 38410221535 passed lint/typecheck/i18n/RTL/design-system/progress/unit/integration/restore/build/e2e. Current branch local evidence: npm run verify passed with 27 unit files/10979 tests and production build; npm run test:integration passed 13 real-PostgreSQL tests/18 migrations; DATABASE_URL-backed npm run test:e2e passed 38/38. Staging acceptance: independent protected preview dpl_ABBnmQjjfdkeWJATFPrFi94cGDmn for the-alvillas-os used Neon spring-credit-88181064 neondb with 18 migrations; pre-change snapshot alvillas-os-staging-before-admin-reset-20261013-085322.dump created; admin.staging@alvillas.test reset through existing bootstrap, same account/person/admin role/business counts preserved, MFA required, sessions revoked to 0 after verifier; protected-browser check verified secure session cookie, MFA, logout, EN/FR/RTL, 360px, keyboard, Admin/Manager/Field routes and authenticated DSN board Owner/Guest shells; health/readiness ok and temporary Vercel bypass revoked. Scope unchanged: all 355 features remain required.
F-DSN-06 | DONE | PR #20/main CI run 38410221535 passed lint/typecheck/i18n/RTL/design-system/progress/unit/integration/restore/build/e2e. Current branch local evidence: npm run verify passed with 27 unit files/10979 tests and production build; npm run test:integration passed 13 real-PostgreSQL tests/18 migrations; DATABASE_URL-backed npm run test:e2e passed 38/38. Staging acceptance: independent protected preview dpl_ABBnmQjjfdkeWJATFPrFi94cGDmn for the-alvillas-os used Neon spring-credit-88181064 neondb with 18 migrations; pre-change snapshot alvillas-os-staging-before-admin-reset-20261013-085322.dump created; admin.staging@alvillas.test reset through existing bootstrap, same account/person/admin role/business counts preserved, MFA required, sessions revoked to 0 after verifier; protected-browser check verified secure session cookie, MFA, logout, EN/FR/RTL, 360px, keyboard, Admin/Manager/Field routes and authenticated DSN board Owner/Guest shells; health/readiness ok and temporary Vercel bypass revoked. Scope unchanged: all 355 features remain required.
F-DSN-07 | DONE | PR #20/main CI run 38410221535 passed lint/typecheck/i18n/RTL/design-system/progress/unit/integration/restore/build/e2e. Current branch local evidence: npm run verify passed with 27 unit files/10979 tests and production build; npm run test:integration passed 13 real-PostgreSQL tests/18 migrations; DATABASE_URL-backed npm run test:e2e passed 38/38. Staging acceptance: independent protected preview dpl_ABBnmQjjfdkeWJATFPrFi94cGDmn for the-alvillas-os used Neon spring-credit-88181064 neondb with 18 migrations; pre-change snapshot alvillas-os-staging-before-admin-reset-20261013-085322.dump created; admin.staging@alvillas.test reset through existing bootstrap, same account/person/admin role/business counts preserved, MFA required, sessions revoked to 0 after verifier; protected-browser check verified secure session cookie, MFA, logout, EN/FR/RTL, 360px, keyboard, Admin/Manager/Field routes and authenticated DSN board Owner/Guest shells; health/readiness ok and temporary Vercel bypass revoked. Scope unchanged: all 355 features remain required.
F-DSN-08 | DONE | PR #20/main CI run 38410221535 passed lint/typecheck/i18n/RTL/design-system/progress/unit/integration/restore/build/e2e. Current branch local evidence: npm run verify passed with 27 unit files/10979 tests and production build; npm run test:integration passed 13 real-PostgreSQL tests/18 migrations; DATABASE_URL-backed npm run test:e2e passed 38/38. Staging acceptance: independent protected preview dpl_ABBnmQjjfdkeWJATFPrFi94cGDmn for the-alvillas-os used Neon spring-credit-88181064 neondb with 18 migrations; pre-change snapshot alvillas-os-staging-before-admin-reset-20261013-085322.dump created; admin.staging@alvillas.test reset through existing bootstrap, same account/person/admin role/business counts preserved, MFA required, sessions revoked to 0 after verifier; protected-browser check verified secure session cookie, MFA, logout, EN/FR/RTL, 360px, keyboard, Admin/Manager/Field routes and authenticated DSN board Owner/Guest shells; health/readiness ok and temporary Vercel bypass revoked. Scope unchanged: all 355 features remain required.
F-DSN-09 | DONE | PR #20/main CI run 38410221535 passed lint/typecheck/i18n/RTL/design-system/progress/unit/integration/restore/build/e2e. Current branch local evidence: npm run verify passed with 27 unit files/10979 tests and production build; npm run test:integration passed 13 real-PostgreSQL tests/18 migrations; DATABASE_URL-backed npm run test:e2e passed 38/38. Staging acceptance: independent protected preview dpl_ABBnmQjjfdkeWJATFPrFi94cGDmn for the-alvillas-os used Neon spring-credit-88181064 neondb with 18 migrations; pre-change snapshot alvillas-os-staging-before-admin-reset-20261013-085322.dump created; admin.staging@alvillas.test reset through existing bootstrap, same account/person/admin role/business counts preserved, MFA required, sessions revoked to 0 after verifier; protected-browser check verified secure session cookie, MFA, logout, EN/FR/RTL, 360px, keyboard, Admin/Manager/Field routes and authenticated DSN board Owner/Guest shells; health/readiness ok and temporary Vercel bypass revoked. Scope unchanged: all 355 features remain required.
F-DSN-10 | DONE | PR #20/main CI run 38410221535 passed lint/typecheck/i18n/RTL/design-system/progress/unit/integration/restore/build/e2e. Current branch local evidence: npm run verify passed with 27 unit files/10979 tests and production build; npm run test:integration passed 13 real-PostgreSQL tests/18 migrations; DATABASE_URL-backed npm run test:e2e passed 38/38. Staging acceptance: independent protected preview dpl_ABBnmQjjfdkeWJATFPrFi94cGDmn for the-alvillas-os used Neon spring-credit-88181064 neondb with 18 migrations; pre-change snapshot alvillas-os-staging-before-admin-reset-20261013-085322.dump created; admin.staging@alvillas.test reset through existing bootstrap, same account/person/admin role/business counts preserved, MFA required, sessions revoked to 0 after verifier; protected-browser check verified secure session cookie, MFA, logout, EN/FR/RTL, 360px, keyboard, Admin/Manager/Field routes and authenticated DSN board Owner/Guest shells; health/readiness ok and temporary Vercel bypass revoked. Scope unchanged: all 355 features remain required.
F-NTF-01 | TODO |
F-NTF-02 | TODO |
F-NTF-03 | TODO |
F-NTF-04 | TODO |
F-NTF-05 | TODO |
F-NTF-06 | TODO |
F-NTF-07 | TODO |
F-NTF-08 | TODO |
F-CFG-01 | DONE | ConfigRule lifecycle/history/effective-date/version engine accepted. Evidence: PR #22 merged to main as 8603cbf on 2026-10-13; CI 38443831593 and main CI 38444678237 green; npm run verify; npm run test:integration; npx playwright test tests/e2e/configuration.spec.ts --project=chromium --project=field-mobile; staging dpl_FTJV6JKyMrdEF7Dg3HZ3iyhVzcDY verifier authenticated /en/app/configuration.
F-CFG-02 | DONE | Shared rule registry and typed values accepted for finance.approval_thresholds, finance.expense_allocation/treatment, finance.payout_schedule and feature_flag.*. Evidence: PR #22 merge 8603cbf; CI 38443831593/38444678237 green; npm run verify; npm run test:integration; staging dpl_FTJV6JKyMrdEF7Dg3HZ3iyhVzcDY finance/feature verifier passed.
F-CFG-03 | DONE | ConfigRuleRepository precedence, effective-date resolution, versions and tombstones accepted. Evidence: PR #22 merge 8603cbf; CI 38443831593/38444678237 green; npm run test:integration resolves rules/snapshots/tenant boundaries; staging dpl_FTJV6JKyMrdEF7Dg3HZ3iyhVzcDY verifier proved draft-active-future-retired property rule lifecycle.
F-CFG-04 | DONE | Append-only lifecycle accepted: create, activate and retire write new immutable versions plus config_rule.version.* audit events; direct update/delete are rejected. Evidence: PR #22 merge 8603cbf; CI 38443831593/38444678237 green; npm run test:integration; staging dpl_FTJV6JKyMrdEF7Dg3HZ3iyhVzcDY verifier update/delete rejected and six audit rows recorded.
F-CFG-05 | DONE | Admin configuration UI accepted for authenticated rule creation, activation, future-version diff/history and retirement. Evidence: PR #22 merge 8603cbf; CI 38443831593/38444678237 green; Playwright configuration.spec chromium+field-mobile passed; staging dpl_FTJV6JKyMrdEF7Dg3HZ3iyhVzcDY authenticated /en/app/configuration showed Retired and Changed rows.
F-CFG-06 | DONE | Reservation consumers accepted: resolved task templates create operational tasks and commission snapshots keep historical owner-statement math stable despite future rules. Evidence: PR #22 merge 8603cbf; CI 38443831593/38444678237 green; Playwright configuration.spec chromium+field-mobile; staging dpl_FTJV6JKyMrdEF7Dg3HZ3iyhVzcDY verifier preserved 25% commission snapshot and owner closing balance 750.00.
F-CFG-07 | DONE | Finance config consumers accepted for approval thresholds, expense allocation/treatment and owner payout schedules with authorization, audit and tenant-isolation coverage. Evidence: PR #22 merge 8603cbf; CI 38443831593/38444678237 green; unit configured-finance-rules; npm run test:integration; staging dpl_FTJV6JKyMrdEF7Dg3HZ3iyhVzcDY finance verifier passed.
F-CFG-08 | DONE | Feature-flag config accepted: feature_flag.* resolves through org fallback and property overrides and drives app-shell owner portal visibility. Evidence: PR #22 merge 8603cbf; CI 38443831593/38444678237 green; npm run verify; npm run test:integration; staging dpl_FTJV6JKyMrdEF7Dg3HZ3iyhVzcDY verifier passed org fallback plus property override.
F-ORG-01 | DONE | Organization settings accepted. Evidence: PR #26 merged bf59509 after PR CI 38483373374 green; PR #27 merged 197e1df for CI Playwright serialization and main checks 38485625569 green. Local: npm run verify; npm run test:integration; npx vitest run tests/unit/organization-service.test.ts; npx playwright test tests/e2e/organization.spec.ts --project=chromium --project=field-mobile; CI=1 npm run test:e2e passed 42 tests. Staging: protected preview dpl_2A8j9aGSRitrA4eseAeXvefRJSFH at commit 197e1df returned health/readiness/version ok with 22 migrations; secure admin recovery revoked sessions without printing secrets; F-ORG-01 verifier passed authenticated /en/app/organization update, unauth redirect, no-permission denial, organization.settings.update audit, app-role RLS, immutable delete block and base-currency lock.
F-ORG-02 | DONE | Regions/cities hierarchy accepted. Evidence: code merged in PR #29 as ab666f4 after CI run 38498934430 green. Local evidence: npm run verify; npm run test:integration; CI=1 Playwright core/configuration/reservations chromium+field-mobile; organization Playwright coverage for geography UI/property city select. Staging: migration 20261014002000_regions_cities_hierarchy applied to independent preview DB; protected preview dpl_1r6MRjcBsDSQMAfo49Qi7sauSkgp READY at https://the-alvillas-byv81c8qe-nadirlagnadi-6231s-projects.vercel.app with app role alvillas_app_preview rolbypassrls=false and readiness ready with 25 migrations; authenticated verifier created region 01a13893-2410-7c1e-9174-5bd61ba39b0d, city 01a13893-362d-7e0f-870b-d94bfcd48fa3 and property 01a13893-7434-7ff2-a221-3d4b08a38ab3 through managed city select, verified region.create audit 01a13893-257d-7de3-93da-6e9a6e9dc553, city.create audit 01a13893-37f2-7512-a3b7-706122da79c9, tenant isolation, region/city no-delete and audit immutability. No production changes.
F-ORG-03 | DONE | Owner contacts/language/representatives/encrypted payout shipped in PR #24; CI run 38477123370 green, merged 66a1c23. Local: npm run verify, npm run test:integration, core Playwright chromium+field-mobile. Staging dpl_2DEkcEsBdCpfb6iknbALAvky7CmG verified auth owners route, masked payout/encrypted at rest, tenant isolation via non-bypass app role, audit/no plaintext, immutable payout/audit.
F-ORG-04 | DONE | Property profile/photos/capacity/timezone/onboarding profile shipped in PR #24; CI run 38477123370 green, merged 66a1c23. Local: npm run verify, npm run test:integration, core Playwright chromium+field-mobile. Staging dpl_2DEkcEsBdCpfb6iknbALAvky7CmG verified authenticated property create/detail, photo gallery, house rules, onboarding notes, tenant isolation, audit and immutable history.
F-ORG-05 | DONE | Property-owner shares accepted. Evidence: PR #31 merged 224d997 after CI run 38502481814 green. Local: npm run typecheck; npm run lint; npx vitest run tests/unit/core-service.test.ts; npm run test:integration; npm run check:schema-drift; npm run test:e2e -- tests/e2e/core.spec.ts --project=chromium --project=field-mobile; npm run verify. Staging: preview dpl_13BvPzNXaZ9f7ne2euQxV1vPCs8s at https://the-alvillas-i4ems4efs-nadirlagnadi-6231s-projects.vercel.app READY; migration 20261014023000_property_owner_shares applied to independent preview DB; readiness ready with 24 migrations; authenticated staging verifier created property 01a1385b-8c50-71cc-a426-de3fcfbc2c9e, saved 60/40 owner shares, verified two active links totaling 10000 bps, one primary owner and property.ownership.update audit. Production deploy remained intentionally canceled by ignored-build rule; no production changes.
F-ORG-06 | DONE | Property operating profiles accepted. Evidence: PR #33 merged 2e28e74 after CI run 38506495290 green. Local: npm run typecheck; npm run lint; npm run check:i18n; npm run check:rtl-css; npm run check:design-system; npx vitest run tests/unit/core-service.test.ts; npm run test:integration; npm run check:schema-drift; npm run test:e2e -- tests/e2e/core.spec.ts --project=chromium --project=field-mobile; npm run verify. Staging: migration 20261014033000_property_operating_profile applied; preview dpl_1r6MRjcBsDSQMAfo49Qi7sauSkgp READY at https://the-alvillas-byv81c8qe-nadirlagnadi-6231s-projects.vercel.app with app role alvillas_app_preview rolbypassrls=false; readiness ready with 25 migrations; verifier created property 01a13889-ad09-7b8f-997a-2159064c411c, updated pool/mid-stay/breakfast/chef/transfers/groceries/wellness/maintenance profile, verified profile 01a13889-ae7b-726d-a28b-e74a5b470338, property.operating_profile.update audit 01a13889-cff7-7b71-803c-fc89ddbda920, tenant isolation, no-delete and audit immutability. No production changes.
F-ORG-07 | DONE | Management agreements accepted. Evidence: PR #36 merged 14aeafe with CI run 38512366227 green; PR #37 merged bdaa64d and PR #38 merged d5602ad after CI runs 38515175628/38516051106 green to repair identity/bootstrap catalog sync for staging admin recovery. Local evidence: npm run verify; npx vitest run tests/unit/identity-standard-setup.test.ts tests/unit/authorize.test.ts; npx vitest run tests/unit/bootstrap-admin.test.ts tests/unit/identity-standard-setup.test.ts; npm run test:integration; npm run test:e2e -- tests/e2e/core.spec.ts --project=chromium --project=field-mobile. Staging: migration 20261014042000_management_agreements applied to independent preview DB; final protected preview dpl_9P3Yavyycy7akNZ7Fmt7ibRGeddM READY at commit d5602ad with readiness ready and 26 migrations. Approved staging admin recovery rotated password, re-enrolled MFA and printed no secrets; verifier created agreement 01a138e6-0c56-7ab4-a9f9-6b214b0201f2 for property 01a138e6-05c0-749e-892b-c1e7e776e447, wrote 7 agreement-scoped config rules, resolved commission at agreement scope, verified owner_agreement.changed audit 01a138e6-10b8-7152-9bb2-680f23a1fde1, authorization denial, tenant isolation, append-only/immutable history, authenticated /en/app/configuration and agreement summary. No production changes.
F-ORG-08 | DONE | Agreement amendments accepted. Evidence: PR #40 merged c25e56f after CI run 38520003199 green. Local: npm run verify; npm run test:integration; npm run test:e2e -- tests/e2e/core.spec.ts --project=chromium --project=field-mobile. Staging: protected preview dpl_4yLQKaGAyRBTM74fCLmSpezDHLcq READY at https://the-alvillas-38vv3wis8-nadirlagnadi-6231s-projects.vercel.app commit c25e56f; readiness ready with 26 migrations; verifier authenticated with MFA, opened /en/app/configuration, created agreement STG-F-ORG-08-76c6694d for property 01a1390e-a2ea-7679-a36f-4738a55c90ec, amended effective 2026-09-01, verified 14 append-only agreement rules, historical commission version 1, amended version 2, one agreement row, owner_agreement.changed audit 01a1390e-f6fb-773b-aa56-fe4e531dd864 and no secret output. No production changes.
F-ORG-09 | DONE | Property lifecycle accepted. Evidence: PR #42 merged 2ef469f after CI run 38536897557 green; final main CI run 38539475256 green with lint, typecheck, i18n, RTL, design-system, boundary, organization-id, schema drift, ledger, audit, progress, unit, real-PostgreSQL integration, restore rehearsal, build and Playwright. Named tests: tests/unit/core-service.test.ts > validates property lifecycle transitions and reasons; denies property lifecycle changes without property edit permission; tests/e2e/core.spec.ts > owners and properties journey. Staging: protected preview dpl_GW8EAw5io6gYk4Q3weWBgK4M8KsX READY at https://the-alvillas-51jffar4e-nadirlagnadi-6231s-projects.vercel.app commit afdda82; readiness ready with 27 migrations; Chromium and field-mobile staging Playwright passed lifecycle Draft -> Onboarding -> Active -> Paused -> Offboarded. No production changes.
F-ORG-10 | DONE | Booking-channel configuration accepted. Evidence: PR #43 merged a01212d after CI run 38537762760 green; final main CI run 38539475256 green with lint, typecheck, i18n, RTL, design-system, boundary, organization-id, schema drift, ledger, audit, progress, unit, real-PostgreSQL integration, restore rehearsal, build and Playwright. Named tests: tests/unit/core-service.test.ts > validates booking channel configuration and normalizes source keys; denies booking channel updates without property edit permission; tests/integration/postgres-migration.test.ts > configures property booking channels with masked endpoints, audit, and tenant isolation. Staging: protected preview dpl_GW8EAw5io6gYk4Q3weWBgK4M8KsX READY at commit afdda82; readiness ready with 27 migrations; Chromium and field-mobile staging Playwright saved Airbnb channel and verified masked endpoint summary. No production changes.
F-ORG-11 | DONE | Property workspace tabs accepted. Evidence: PR #44 merged afdda82 after CI run 38538614094 green; final main CI run 38539475256 green with lint, typecheck, i18n, RTL, design-system, boundary, organization-id, schema drift, ledger, audit, progress, unit, real-PostgreSQL integration, restore rehearsal, build and Playwright. Named test: tests/e2e/core.spec.ts > owners and properties journey verifies Overview, Calendar, Reservations, Operations, Laundry, Maintenance, Assets, Documents, Team and Rules tabs plus workspace summary/assets/documents/team sections. Staging: protected preview dpl_GW8EAw5io6gYk4Q3weWBgK4M8KsX READY at commit afdda82; readiness ready with 27 migrations; Chromium and field-mobile staging Playwright passed against protected preview using Vercel OIDC header. No production changes.
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
