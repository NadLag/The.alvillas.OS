# ADR 0149: Isolated mandatory verification jobs

Date: 2026-11-02

Static checks, unit tests, PostgreSQL integration, restore/build and Playwright run as independently reported jobs. Each database job owns a PostgreSQL service on its own runner. The existing restore rehearsal also retains its separately created source and target containers. Browser acceptance migrates and bootstraps its own database; it does not depend on financial rows left by integration tests. A browser build is repeated in that isolated environment so browser acceptance can start without waiting for the integration and restore jobs.

Desktop Chromium and Pixel 5 browser projects also run on separate runners with separate PostgreSQL services, application builds, ephemeral keys and original global setup. Each project retains one browser worker. No test file is divided or filtered within its project. Matrix fail-fast is disabled so a failed project retains evidence without cancelling the other mandatory project. Each project uses a distinct artifact name and records its project identity. The additional isolated build costs runner time; its effect on the critical path must be measured.

The original `checks` context remains the merge barrier. It runs after every mandatory job group, including failed or cancelled jobs, and succeeds only when all five results are `success`, including the combined result of both browser projects. A skipped, cancelled, missing or failed result cannot satisfy the barrier. Existing security, schema, restore, build, financial, authorization and feature-ID commands remain mandatory. Browser workers, test declarations, assertions and time budgets are retained. The effective browser retry count remains zero.

Concurrency groups include the workflow, event and PR number. A newer commit can cancel an earlier run for the same PR. Main runs use their unique run IDs, so a new main commit cannot replace running or pending main verification. The existing staging job and deployment settings remain unchanged.

Each job records its actual checked-out head, expected event head, source tree, lock hash and complete test-content hash. Unit, PostgreSQL and browser reports are retained independently. Outcome metadata is uploaded even after failure or cancellation; browser diagnostics are retained for failed and superseded runs. No credentials or environment dump enter the manifests.

Every browser project records its full discovered case list before execution. The merge barrier downloads both project artifacts and requires their exact head, tree, lock, test-content hash and run attempt to match. Every discovered case must appear exactly once with one passing attempt and zero retries. Missing projects or cases, skipped cases, duplicate cases, unexpected outcomes, retries and changed source evidence fail the barrier. Desktop and mobile discovery must form the complete disjoint union of the original browser declarations.

The sequential baseline and the split workflow use the same application and financial test content. Compare actual workflow elapsed time, queue delay, job duration, test totals, restore evidence and zero-retry browser results before accepting the optimization. Early independently reported failures are an additional benefit; estimated savings do not count as measured results.
