# ADR0176 — Config-backed tax interfaces

The locked specification defers actual Moroccan VAT, tourist-tax and accounting treatment to the accountant. F-FIN-36 supplies TaxRule, TaxRate, TaxCategory, effective-date and property/service/transaction-type interfaces without choosing a treatment, supplying a rate or inferring a tax liability.

Keep the existing finance.tax ConfigRule as the single versioned source. Reuse its explicit amount, currency, basis-points and service-assessment fields and the existing exact service assessment implementation. Optional tax_hook metadata defines named multilingual categories and explicit context selectors; missing metadata remains deferred, and no policy remains distinct from an explicit nonmatching policy. No derived zero stands for an absent decision.

Tax models are read projections of immutable policy versions. Their native query interface must retain organization scope, original policy identity and effective dates rather than introducing a second mutable rate engine. Existing service allocation policy snapshots and postings remain intact. Views or repositories must enforce original config/source authority and recheck it before disclosure. The interfaces do not create tax postings or activate country-specific accounting treatment.

Provide tax_rule, tax_rate and tax_category as native security-invoker read views over the existing ConfigRule versions. Each view carries organization, policy identity, scope and effective dates and inherits the source table's forced tenant isolation. Parameterized repositories select the actual resolved policy. This keeps the handbook's tax models tied to their single authoritative configuration and preserves historical versions without duplicating editable financial rules.
