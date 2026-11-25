# ADR 0277 — Property types on existing inventory templates

Status: Accepted

F-INV-09 extends the existing `inventory.minimums` value with optional `property_types`. These are exact owner-entered property type identifiers. An absent restriction preserves universal legacy templates; an explicit list restricts selection and application. The existing immutable template versions, inherited field differences, property overrides, configuration writer and audit remain authoritative.

The existing template catalog and onboarding choices filter type compatibility before pagination. Direct application and onboarding review check the actual current property type. Publication repeats that check at the final audit boundary; current configuration/property authority is required for creation, application and disclosure. No catalog, template table, financial engine, stock movements or schema migration is added.
