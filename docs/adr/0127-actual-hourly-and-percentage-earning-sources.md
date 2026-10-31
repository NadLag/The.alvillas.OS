# ADR 0127 — Actual hourly and percentage earning sources

Contract estimates cannot establish an earned quantity. Hourly earnings require retained actual work intervals, their completed-work source, the actual performer, and a recorded validation decision. Scheduled task duration is never used as worked time. The policy explicitly chooses interval limits and whether the validator must be a different person. Operational work evidence does not disclose contractual rates or payable amounts.

Hourly calculations retain millisecond instants and every original effective-rate segment. Percentage calculations retain actual immutable posting identities and effective contracts; configured buckets and posting side select the financial basis. Entered estimates, wallet balances and inferred ownership are not percentage bases. Independent financial visibility of the original basis remains required.

Both calculations use the shared Money implementation, exact integer weighting and one final rounding at the earning total. Every original rate remains independently authorized alongside the whole beneficiary amount. Evidence approval does not replace compensation cost allocation, owner approval, recognition or settlement; those continue through the existing financial chain.

Evidence, decisions and earning witnesses are tenant-bound and append-only. Corrections must link their original sources and use the existing cancellation or opposite-journal boundaries; existing earnings and financial rows are never rewritten. New database guards must be rollback-qualified before migration admission, and held/current source authority is rechecked before releasing data or committing a command.

Work-time recording uses operational task edit authority, and validation uses task validate authority. Shared task-resource facts, command fingerprints and PostgreSQL transaction locks keep the operational and financial source readers consistent without cross-module repository imports. Recording work does not grant financial visibility. Each version retains its actual policy, source event, intervals and atomic audit/outbox attribution; a later policy controls new versions while validation and exact replay retain their original policy.

Applied SQL remains immutable. Tenant policies are also declared explicitly in a forward migration so the existing static isolation gate can verify the same FORCE RLS policies exercised by the NOBYPASS behavioral checks. Policy replacement is transactional and preserves existing business values and row versions.

Scope unchanged: all 355 features remain required.
