# ADR 0266 — Chef requirements derive from original service orders

Status: accepted technical implementation for F-SVC-05. All 355 feature IDs remain required.

Ingredient requirements derive from the immutable native service-order recipe and its captured dimensions. Catalog pricing and recipe requirements share one exact integer multiplier for FIXED, PER_GUEST, PER_DAY and CUSTOM units. Six-decimal recipe quantities use integer millionths; aggregation and localized rendering preserve every digit beyond JavaScript number precision. No financial calculation or posting path changes.

The property shopping list includes complete requirements of visible REQUESTED, QUOTED and CONFIRMED Chef orders overlapping the selected service dates. Fulfilled and cancelled orders no longer require shopping. A partial date overlap retains the complete original order quantities and displays its complete service interval. Ingredient identities, multilingual labels and units must agree before aggregation. No unit conversion or stock subtraction is inferred.

Native property, reservation, service and order metadata authority precedes the SQL projection of ingredients and dimensions. Held and current permissions apply independently; a second native-source check after the attributed read audit withholds changed or revoked selections. The response contains no private guest or financial terms. The transport returns the complete authorized result or requires a narrower date range at 500 orders or one MiB; it never silently truncates requirements.

Actual task recipes also carry derived full-order ingredients and servings. The existing actor-bound field cache retains this optional extension, allowing older cached recipes to remain readable until refreshed. No second catalog, ingredient snapshot, inventory balance, grocery order, receipt store or reimbursement engine is introduced. Purchasing and financial settlement remain F-SVC-07 over the existing native producers.
