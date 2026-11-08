# ADR 0214: Bound unit compiler inputs as the approved catalogue grows

The CRM workspace checkpoint exhausted the unit compiler's existing 2048 MiB heap. All four PostgreSQL compilers, the application compiler and the browser compiler passed. A diagnostic that removed the profile unit test's database-fixture import still exhausted the same heap. Both failures are retained; increasing the heap does not address catalogue growth.

Partition unit roots into deterministic groups of at most 96, using the existing compiler runner and shared ambient context. Preserve the first `unit` project name and report every additional `unit-N` compiler independently. Keep the existing per-process heap, scheduling resource checks, all native partitions and all original TypeScript inputs. No assertion, browser retry, timeout, branch protection or workflow gate changes.

Static and all three production builds independently discover both native and unit root counts. The aggregate gate requires matching counts and every actual compiler result. Missing, failed, stale or mismatched unit partitions reject release evidence. Local and deployment builds continue checking all non-application partitions before Next checks the application.

Verification compares complete root coverage, injects a real TypeScript error into every added unit partition, and rejects omitted or failed partition evidence. Measure actual elapsed time and peak RSS separately from end-to-end CI; a successful memory-capacity correction is not a claim of reduced CI wall-clock time.

Scope unchanged: all 355 features remain required.
