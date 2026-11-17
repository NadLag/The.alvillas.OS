# ADR 0280 — Supplier quotes reuse native configuration versions

Status: Accepted

Named laundry supplier quotes use `operations.laundry_pricing.supplier.<supplier UUID>` in the existing configuration engine. It owns version order, effective windows, draft activation, retirement and scope inheritance. Each list has one explicit currency and exact Money amounts per original LINEN SKU and counting unit. Legacy global definitions retain their original shape and never silently become a supplier quote.

The immutable `supplier_price_list_version` record links each native configuration version to its actual supplier, currency and author. It holds no parallel price payload or lifecycle. Every native configuration producer appends that reference, including activation and retirement. Forced tenant isolation, original composite references and deferred source/audit proof reject mismatched units, foreign sources and unattributed versions.

Prices require independent supplier-invoice financial visibility; named lists also require the original supplier's personal-data authority. Exports require both source export grants. Native configuration reads, writes, history and audit masking share those checks. Property-scoped pricing uses the actual current property through the existing source authorizer, including final write fences. Quote configuration creates no expense, invoice, charge, payment, stock movement or journal entry.
