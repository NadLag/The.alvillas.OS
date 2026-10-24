# ADR 0063: Concurrent implicit geography creation

Date: 2026-10-24

Status: Accepted

Two first property submissions can both observe an absent city or region. The existing tenant-scoped, case-insensitive uniqueness indexes then reject one property transaction. Real PostgreSQL regressions reproduce this for eight simultaneous native creates both with and without a region.

Keep the existing repository and authorization/audit transaction. When implicit geography is absent, use a parameterized `INSERT ... ON CONFLICT DO NOTHING`, then read the canonical active tenant row in a fresh statement. Existing geography is never updated, and each property and its audit commit once. Explicit geography administration retains its existing conflict semantics. No schema or financial-data change is required.

PostgreSQL documents [conflict handling](https://www.postgresql.org/docs/17/sql-insert.html#SQL-ON-CONFLICT) and [fresh statement snapshots under Read Committed](https://www.postgresql.org/docs/17/transaction-iso.html#XACT-READ-COMMITTED). The regressions require eight properties, one city/region, eight creation audits and no visible foreign-tenant cities.
