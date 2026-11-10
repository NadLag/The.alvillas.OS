# ADR 0234 — Native onboarding Services

Services reuses the canonical `services.pricing` configuration and `SERVICE_CATALOG` template. LINK selects the actual resolved configuration, TEMPLATE applies an actual canonical version, and CUSTOM writes explicit catalog settings through the existing configuration writer. The approved organization policy owns the allowed modes and required catalog count. The existing 200-entry catalog bound remains a protocol limit.

Custom choices include EN/FR labels, an explicit optional description, availability, pricing model, amount and currency. All amounts remain strings and pass through `Money`; a deliberately unknown quote amount never becomes zero. Legacy history retains missing values as missing, while full original configuration and private unknown fields belong to the encrypted original envelope. Public records project registered fields only.

Catalog configuration and original price history require independent held and current financial source authority before values are read and again after the canonical audit. Property editing does not grant financial access. Native admission must retain the actual Owner context and canonical command, original before/after values, creator nonce, approved policy and source lineage. It creates no service booking, charge, financial movement, provider connection or operational Property.

Contracts and policy are being implemented behind closed shared dispatch. Canonical source authorization, durable admission and additive database protections, selectors, private EN/FR/RTL UI, real PostgreSQL, browser, populated restore and exact-head CI remain required. No feature is promoted to DONE. Scope unchanged: all 355 features remain required.
