# ADR 0177: Accountant attachments preserve original financial sources

Accountant reports aggregate financial records whose ownership, custody, party identity and authorization remain independent. Rendering a file must never create another expense, payment or balance.

All seven report kinds use the original sealed journals, immutable recognition and payment receipts, canonical owner statement builder, or original bank facts and reconciliation history. Payment reversals retain the original receipt even when the original falls outside the selected period or its claim is later corrected. Beneficiary wallet offsets have distinct record types. Historical bank bindings remain available after current configuration changes. Bank records and whole-claim payments do not infer a property allocation.

The organization configures report availability, file capacities, durable admission limits, and explicit income and expense classifications in `finance.accountant_exports`. Missing classification, currency, reporting calendar or required source evidence fails closed. No Moroccan tax treatment or accounting taxonomy is assumed.

The export requires held and current organization authority for every independent financial, party, property and configuration source. This conservative complete-source boundary also controls configuration and generic audit disclosure. Admission commits independently. The renderer runs within a final transaction, followed by an attributed success audit and fresh source, configuration and permission checks. Bytes leave the service only after that transaction commits. A failed renderer or changed source cannot disclose a file or reset admission.

Every attachment identifies its period, currency, reporting timezone, explicit filters, policy identity and source fingerprint, including empty reports. CSV retains exact decimal strings and escapes spreadsheet formulas only in text. XLSX uses typed string cells rather than binary numeric cells or formulas. PDF uses locally bundled, licensed fonts for EN/FR and the existing configured renderer contract for Arabic content. An unavailable Arabic renderer produces a configuration refusal; CSV and Excel remain available. No financial records enter offline storage.

Capacity refusal precedes file emission; complete reports never silently paginate or truncate. Native selectors paginate independently. No business tables, balance fields or migrations are added.
