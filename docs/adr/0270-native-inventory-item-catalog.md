# ADR 0270: Author the existing inventory item catalog

Status: Accepted

F-INV-01 uses the existing tenant-bound InventoryItem table. Consumables and
linen retain their original category keys; EQUIPMENT remains the canonical
key for long-life assets. No asset register or parallel item catalog is added.

An item's original SKU, category and counting unit define its quantity stream.
Explicitly authorized, reasoned commands create, rename, retire and restore
items. Renaming changes multilingual labels only. A changed unit or category
requires another SKU, without converting or rewriting existing movements.
Legacy items with an unspecified original unit retain that identity.

Retirement requires zero actual stock at every location independently.
Opposite quantities at two locations cannot cancel this requirement. Item
commands use the existing stocktake catalog lock, immutable audit writer and
outbox. Held and current tenant authorization and original row fingerprints
are checked throughout; command nonces serialize replay and recovery.

Nonce-only recovery durably closes a request that has not been recorded under
the same command lock. Its immutable negative receipt prevents a delayed
original request from arriving after the recovery response and creating a
second item. Neither private item drafts nor labels are stored in browser
storage. Offline, hidden and restored pages discard private responses.

Property minimum and expected-consumption rules remain in config_rule.
An explicit legacy property definition is preserved. When definition fields
are absent, field snapshots and stocktakes resolve the existing canonical
item instead of duplicating its name, category or unit in those rules.
Original movement, stocktake and configuration provenance remain intact.
