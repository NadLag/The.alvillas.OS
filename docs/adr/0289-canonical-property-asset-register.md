# ADR 0289. Canonical property asset register

The asset identity owns one immutable organization, property and tag. Revisions retain condition, warranty, useful life and the original purchase amount as an exact decimal in its source currency. The purchase amount uses a separate financial permission and register changes have no accounting effect.

Maintenance issue and work-order references use the canonical asset and bind reviewed revisions. Existing operations tasks, issue history, approvals and journal records retain their original identity.
