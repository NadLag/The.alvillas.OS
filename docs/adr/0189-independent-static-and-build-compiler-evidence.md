# Independent static and application build compiler evidence

CI's static job checks all five compiler partitions, including shared ambient context and every original application, unit, PostgreSQL and browser/tool root. Each restore and browser build previously repeated the four non-application partitions before Next checked the application again.

Keep all five partitions mandatory in static. In the two authenticated browser jobs and restore/build job, an explicit CI-only mode lets Next check its original application configuration and generated route types while relying on the independently reported static test-partition coverage. Preserve local and deployment build defaults, compiler roots, heap limits, assertions and zero browser retries.

The mode requires GitHub Actions, an allowed build job and a matching start manifest. The aggregate gate validates complete static coverage and all three successful application builds against the exact source head, tree, test content, lockfile, run and attempt. Missing, failed, partial or stale evidence cannot satisfy the gate. PR supersession cancellation, mandatory main verification, deployment behavior and branch protection remain unchanged.

A retained Windows full verification exhausted the default ESLint heap before reaching application assertions. CI's lint step uses the existing bounded 6 GiB compiler budget; it retains the same typed rules and zero-warning requirement. Measure original and changed build-step and complete-run wall time on the same financial application inputs before claiming savings. Application and financial changes remain in their own dependent PRs.
