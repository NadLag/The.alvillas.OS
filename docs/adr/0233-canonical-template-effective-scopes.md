# ADR 0233 — Canonical template effective scopes

Three real Inventory regressions exposed a shared template defect: a matching City-scoped Property editor was rejected without the Property geography, and application could disagree with review when a City or Owner configuration overrode the organization setting.

Resolve template projections through the existing ReservationConfigScopeRepository and ConfigRuleRepository. Bind authorization to the actual Property metadata and check both held and stored authority before reading private source values and after writing the canonical audit. Keep the existing financial template gates and presentation policies.

An Owner configuration context must be explicitly supplied and belong to the Property. Retain that context in the existing immutable template command; reuse it for state, overrides, reset and operation replay. Never infer a primary Owner or silently substitute another context. The existing client carries the recorded Owner through subsequent commands.

Move the three existing template error constructors to the existing Core access module and re-export the same constructors. Native adapters can identify denial and conflict without importing a framework request service. There is no parallel template, Owner, configuration writer or error implementation.

Eight actual PostgreSQL regressions cover the original City/Owner failures, exact zero quantities, state/reset/replay, an unrelated Owner, current permission withdrawal and atomic rollback after a late withdrawal. Existing template, audit privacy, financial masking, immutable history and tenant assertions remain mandatory. F-TPL-02 and F-TPL-06 stay IN-PROGRESS until the focused release and acceptance gates qualify.
