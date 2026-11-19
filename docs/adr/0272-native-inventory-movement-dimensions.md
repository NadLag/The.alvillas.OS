# ADR 0272: Extend the original stock movement ledger

Status: Accepted

F-INV-03 extends InventoryMovement and its existing per-location/item revision
cursor. Physical quantity, reserved quantity and damaged quantity are derived
independently from immutable deltas. Damage remains physically present;
loss and disposal record their distinct actual outcomes. Neither metadata
changes nor commands edit balances or reclassify original counting units.
Money, valuation, expense allocations and reimbursements remain in Finance.

Purchase, consumption, damage, loss, disposal and adjustment are attributed
single-stream movements. Transfers and laundry movements commit matched
opposite location legs for the same original item. Reservation and release
refer to the actual reservation, and consumption can use only that
reservation's verified outstanding hold. Existing field stocktake observations
remain the authoritative count interface and keep their original invariants.

Real counts can reveal shortages against existing reservations or condition
records. Those commitments and original damage records remain immutable.
Explicit release, correction or reversal resolves them; a count never silently
erases a reservation or turns damaged stock into usable stock.

All new commands use the original catalog/location/stock locks, current cursor,
held and current source authorization, audit writer and outbox. SQL guards
retain the original stocktake branch and require new movement groups,
revisions, exact deltas, attributed audit and command receipt to commit
together. Every reversal appends one exact opposite group and preserves its
original rows. Subsequent use or commitments can prevent reversal until the
actual stock is reconciled.

The existing counting-unit contract uses exact integer strings and BigInt;
there is no implicit conversion or floating-point quantity arithmetic. Private
operational projections omit financial costs. Purchases are linked to the
existing expense engine in F-INV-07 without recognizing the same expense again.
