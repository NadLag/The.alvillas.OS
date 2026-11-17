# ADR 0267 — Chef compensation uses canonical staff contracts

Status: accepted implementation for F-SVC-06. All 355 feature IDs remain required.

The original Chef order's PERSON binding selects its staff compensation profile. A private audited context read requires held and current `staff_compensation:view` authority for that exact person, property and task, independently of operational or catalog permissions. It rechecks original source identity and current permissions after the audit. Contract creation and compensation-run links retain their separate native authorizations. Nothing is cached outside the existing private component lifecycle.

Staff author the Chef's effective-dated PER_JOB, PER_HOUR, PER_MONTH and PERCENTAGE terms through the existing Team compensation form and `staff.compensation` configuration writer. The same contract history, Money calculations, estimates, evidence preparation, claims, approvals, recognition, payables, settlement and reversal remain canonical. There is no Chef-specific rate table, formula, payroll, estimate calculator or automatic earning on menu selection.

Contractual estimates remain estimates. Native earned sources require completed jobs, approved actual work intervals, eligible monthly coverage or immutable original percentage bases, according to their existing rules. F-SVC-04 already binds service cost recognition to the original actual Chef; a different person's employee cost cannot satisfy that component. Existing financial history is never rewritten when a later contract version changes.
