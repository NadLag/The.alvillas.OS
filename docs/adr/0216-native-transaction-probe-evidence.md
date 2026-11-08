# ADR 0216: Retain connection probes separately from transaction queries

The private CRM directory benchmark compares the complete SQL transaction at
100 and 500 captures. Prisma can emit a pool health check, exactly `SELECT 1`,
before `BEGIN` when a connection has been idle. Counting this probe as an
application query makes equal transaction sequences produce different totals.
The retained native SQL diagnostic demonstrated the extra statement outside
the transaction; warming the connection did not reliably prevent recurrence.

The existing query meter records that exact pre-transaction probe separately
as `connectionProbes`. It still counts `BEGIN`, every application statement
(including `SELECT 1` within the transaction), and the terminal `COMMIT`.
Any other statement before `BEGIN`, overlapping measurements, multiple
transactions or an incomplete receipt fails verification. Both counts remain
available as evidence, and total elapsed time still includes the probe.

All original query-count comparisons, query budgets, latency budgets,
portfolio completeness and financial preservation assertions remain intact.
No browser retry, timeout, production configuration or required gate changes.
