# ADR 0273: Reuse native inventory rules and automation suggestions

Status: Accepted

F-INV-05 extends `inventory.minimums`, the native outbox and the existing
automation `reorder_suggestion` action. Original SKU definitions, quantities,
field observations and financial postings remain in their existing systems.
Legacy rules retain physical-count treatment. Available-stock basis and target
quantities are explicit operational configuration, with location overrides in
the same versioned policy.

Signals retain the actual location, item, stock revision, causal movement/count
or configuration, and effective minimum-rule version. Processing checks current
source authority and freshness before creating effects. A superseded source is
skipped; an old recommendation never becomes another stock movement or expense.

The existing AutomationSuggestion table gains optional native location,
item and provenance references. Company stores have their actual location and
no fabricated property. Quantity precision widens while retaining its original
decimal scale, fractional legacy values, identities and history. No financial
column or posting is changed. Native suggestion rows are immutable; legacy
lifecycle behavior is retained. Current
projections distinguish applicable recommendations from historical sources.

Configuration changes use the existing authorized, append-only version writer.
Durable references are idempotent per original version, activation/expiry phase
and bounded continuation. Effective dates use the existing outbox delay and
worker infrastructure; each continuation examines at most fifty original streams.
The effect, successful run and attributed audit share the actual automation
action savepoint transaction; previously committed effects cannot prove a new
one. Financial predicates, recorded outcomes and their audit disclosures retain
the original registered financial source checks in addition to inventory access.
No parallel catalog, rule engine, financial engine or balance cache is introduced.
