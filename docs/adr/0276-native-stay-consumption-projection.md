# ADR 0276 — Per-stay requirements on original configuration and movements

Status: Accepted

F-INV-08 projects the existing `inventory.minimums.expected_per_stay` setting once for each stay, in the original item unit. It resolves the existing configuration hierarchy at arrival midnight in the property's timezone, including the effective management agreement and booking source. Explicit zero is distinct from an unspecified requirement. No rate per guest or night is inferred.

The requirement is an operational forecast. Reading it creates no reservation, consumption, balance, expense, valuation or financial posting. Original consumption movements attributed to the reservation, and their original reversals, supply the actual quantity. Other movements and unassigned consumption are excluded. Actual minus expected is calculated with exact integers; missing or incompatible settings remain unspecified. Cancelled, no-show and archived sources retain recorded history without an assumed requirement.

The paginated EN/FR/AR view includes original configuration provenance, missing/retired catalog definitions and actual quantities even when no expectation exists. Current and held inventory, reservation, property and configuration authority govern reads. Two source snapshots and a final authorization fence detect source changes and withdrawn access. The client clears private data on visibility, offline and page lifecycle changes. Existing configuration and movement history remain the only editing paths.
