# 0205 — Bound native compiler input groups

The native TypeScript groups reached their existing 6 GB heap budget as the approved feature catalog grew. Native primary roots now form balanced groups of at most 36 files, with at least the two original groups retained. Shared ambient declarations remain in every group. The planner still rejects any dropped original input, and native compilers continue to run serially at their unchanged heap limit.

Static evidence records the discovered native input count and requires a successful result from every derived group. Each independent production build must discover the same native count. Coverage aggregation rejects an omitted group, a failed compiler, mismatched input counts, stale source evidence or a missing application build. Every required check, application compiler, test assertion and zero-retry browser gate remains mandatory.
