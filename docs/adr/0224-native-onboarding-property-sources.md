# ADR 0224 — Native property sources during onboarding

The Property step uses the existing Core Property, ownership and geography records and the canonical Core creation service. Its source witness includes the property tuple and every active ownership tuple. Admission must recheck current and held authorization, the selected Owner, the saved predecessor and the source after the canonical audit. Financial relations are outside these identity queries.

Property creation requires an explicit approved reference to an entry in `ops.operating_rules`. Every operating choice that Core could otherwise default must be present in that configuration and pass the existing Core operating-profile validator. A missing reference or incomplete configuration keeps creation closed. Linking an existing property retains its actual configuration for the later Operating Profile step.

Physical snapshots retain explicit original values under the existing private payload encryption. They contain no agreement terms, payouts or balances. Subsequent native producers and ordered SQL guards must prove step completion; client readiness flags cannot activate a property. The applied 220 migrations remain unchanged.
