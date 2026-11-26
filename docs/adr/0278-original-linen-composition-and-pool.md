# ADR 0278 — Linen composition on original inventory units

Status: Accepted

Linen sets are versioned operational composition in the existing `inventory.minimums.linen_sets` configuration. Each set references original catalog SKUs and explicit positive unit counts. The native inventory template writer, inheritance, overrides and onboarding projections retain that composition. A set definition creates no physical units or financial postings.

The circulating pool reuses the original stock screen, original immutable movement streams and held/current source permissions. A complete set is limited by the scarcest compatible LINEN component after original reservations and damage. Missing, retired, wrong-category or unspecified-unit components produce an unavailable result; a held shortage produces zero complete sets. Quantities at property, store, laundry and transit locations remain separate original movements. Stock viewing, template composition and the pool use no parallel catalog, balance or financial engine.
