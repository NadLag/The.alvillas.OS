# MISSION.md — ALVILLAS OS

## The goal
Build the **complete, production-ready ALVILLAS OS**: the private operating and financial system of ALVILLAS SARL (villa management for third-party owners in Morocco). All 355 features, all 14 phases, live in production, running the whole business. **Not an MVP, not a demo, not a first version.**

## Finished means (the only way this mission ends)
- All 355 features in `PROGRESS.md` are `DONE` with evidence (test names, PR, CI link).
- All 14 phase exit gates (handbook Part E) have passed.
- The 30-step Golden Path (handbook J.2) is green in CI and on staging.
- Load test at 500 properties, external penetration test, backup and restore drill, accessibility audit are completed.
- `docs/STUBS.md` is empty.
- Every item in handbook Part L is resolved or accepted by the owner in writing.
- A pilot month on real villas reconciles to the bank and the old spreadsheets.

## Scope guard
1. `PROGRESS.md` is the completeness ledger. It always holds exactly the 355 IDs in `docs/FEATURE_IDS.lock` plus the 14 phase gates. Nothing is deleted, merged, renamed, descoped or declared "not needed". New IDs only with the owner's approval.
2. Nothing is deferred or "phase 2'd" without the owner's written approval. The default answer to "can we drop or postpone this?" is **no**.
3. **Blocked is not skipped.** Legal, credential or third-party blocks keep the feature `IN-PROGRESS` with the reason; build everything around it behind the provider interface.
4. **Shortcuts are not DONE:** stubs, fakes on non-test paths, hard-coded values, seed-only data, mock screens, TODO comments, disabled buttons, demo-organization-only behaviour. They stay `IN-PROGRESS` and are listed in `docs/STUBS.md`.
5. **DONE** = the handbook Definition of Done (D.2) is fully met: works end to end in the running app, unit and Postgres integration tests, authorization and tenant isolation, audit events, EN and FR strings, accessibility, UX states (loading, empty, error, offline where relevant), CI green, merged to main, verified on staging.
6. Increments (handbook A.3) are an order, not a reduction. Finish a module before starting another. Do not build on unfinished foundations (identity, authorization, audit, i18n): close that phase debt first.
7. Every work item names the feature IDs it closes. Unfinished IDs carry forward; they are never silently dropped. Every work order carries the line: **"Scope unchanged: all 355 features remain required."**

## Priorities right now
1. **Close-out pass:** take every `IN-PROGRESS` feature to `DONE`, or write the exact blocker next to it. Do this module by module.
2. **Phase debt:** identity (IDN), authorization (AUZ), audit (AUD), i18n (I18), design system (DSN), configuration (CFG) must be complete, because everything else depends on them.
3. Then continue module by module in phase order, with the design quality in `DESIGN_BRIEF.md`.

## Completeness tooling (keep working in CI)
- `check:progress` must compare against `docs/FEATURE_IDS.lock`, require exactly 355 IDs (including IDs with digits such as `F-I18-01`), and fail on any missing, extra, renamed or duplicate ID.
- `npm run progress:report` prints per-module and per-phase counts of DONE / IN-PROGRESS / TODO and lists phase gates.

## Stop and ask the owner only for
Legal, tax, accounting or data-protection answers · accounts and credentials (one batched list) · production database changes and production promotion · anything that would delete financial data or break a handbook decision · any proposal to drop or defer a feature.
