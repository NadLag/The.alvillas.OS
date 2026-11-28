# 0269 — Native transfer pickups and cash custody

Date: 2026-11-16

F-SVC-08 extends the existing property Services catalog, original request, native TRANSFER task and field cache. A request contains one pickup date, local time, locations, passenger count and optional flight reference/instructions. The original property timezone remains part of its immutable source witness. Return pickups use another canonical order. Prices, providers, effective allocations, tax and availability remain existing configuration.

Operations assigns the actual driver through the existing scheduling and authorization workflow. Confirmation asserts no actual work or money. Assigned field snapshots expose pickup instructions without catalog prices, provider costs, financial policies or unrelated guest records. Current assignment and authority are checked again before snapshots are published.

Actual guest cash uses the native offline collection command and custody journal: debit the collector's cash custody and credit unallocated collections. Work completion, service recognition, driver compensation and allocation remain separate native processes.

The handbook G.3(9) cash handover extends the canonical financial transfer command with an original collection reference. It debits the actual receiving company cash/bank location and credits that collection's actual custodian. Partial handovers are bounded by the receipt's ledger-derived remaining custody. They change neither ownership allocations nor service revenue/cost. Cash retained by the driver remains in custody; it is never silently treated as compensation or an expense.

Native locks, command identities, original audit and exact posting guards prevent duplicate or excessive handover. Nonce-only recovery waits behind the same command lock. Reversals append exact opposites; an original collection cannot be reversed while its cash remains handed over.

Original collection, property finance, source journal and physical accounts require independent held/current access. These restrictions also apply to transfer history, attachments and audit presentation. Forward migrations preserve every applied checksum and existing financial row.

F-SVC-08 remains IN-PROGRESS pending complete qualifying verification and hosted acceptance. Vercel restrictions continue to block hosted acceptance. No provider, billing or production settings change.
