# ADR 0126 — Reach authorized accounts beyond the first page

CI41182087836 and CI41184435459 exposed native financial selectors and identity administration that returned only the first 100 records. Larger genuine account fixtures made valid accounts unreachable.

Finance uses one bounded keyset reader and shared native picker for expense funding, accommodation receipts and settlement import. Private POST bodies carry search and pagination. Every account requires independent financial visibility in the actual expense context or the existing organization revenue context. Staff wallets retain independent wallet authority. Held restrictions and current stored grants intersect before and after each read; actual draft facts and returned account metadata are rechecked before release. A private read audit records source and count, without search text. Reads expose metadata, never balances. Submission continues through the existing canonical financial services.

Identity administration searches and pages actual tenant accounts through an authenticated server action. Current and held collection authority are both required. Search text stays out of URLs. Account mutations, recovery credentials and financial writes retain their existing services and audit behavior.

Regressions retain the complete financial assertions and use the real search controls. PostgreSQL acceptance covers more than 100 accounts, tenant isolation, restricted and revoked authority, staff-wallet visibility and concurrent metadata changes. Failed CI and local diagnostic evidence is preserved. This repair changes no feature status, migration or business rule.
