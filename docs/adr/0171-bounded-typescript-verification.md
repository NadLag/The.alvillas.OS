# ADR0171 — Bounded TypeScript verification

The growing application and native acceptance catalog exceed the existing compiler process's 6 GiB heap when checked together. Retain that ceiling and the exact compiler configuration. Check application, unit, PostgreSQL and browser/tooling roots in separate compiler processes. Each uses the installed project-local TypeScript compiler with no emit and propagates its actual failure status.

The PostgreSQL catalog keeps its 6 GiB heap and runs alone. Other groups use measured 3/2/2 GiB limits, with at most two concurrent read-only compiler processes. Launch a second process only when the available CPU and memory accommodate both heap budgets plus a 1 GiB reserve; otherwise run sequentially. No compiler writes output or shares a build-info cache. All groups run and retain their diagnostics even when another fails.

Discover roots from the authoritative tsconfig and its complete original compiler program. Share every original declaration and global/reference context, including worker library directives, across all groups. This preserves global augmentation and ambient library semantics. Retain every original root and reject a generated root outside the original program. Compare the real compiler input lists and compiler options before accepting the change; imported application dependencies remain checked normally in every consuming group.

The build checks all three test/tooling groups before invoking Next.js. Next keeps its strict application typecheck, using the generated application project and dynamic includes for newly generated route types. Development keeps its original tsconfig. No compiler option, assertion, security check or mandatory CI gate is disabled. Job names, required branch protection, database isolation and zero-retry browser acceptance remain unchanged.

Each compiler process reports elapsed time and peak resident memory. Compare the original and grouped commands against the same source and dependencies on the same machine. Keep raw measurements and exact input-coverage proof with the CI evidence; report measured changes without extrapolating an end-to-end CI saving.
