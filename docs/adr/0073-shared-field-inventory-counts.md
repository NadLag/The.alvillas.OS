# 0073 — Share field inventory counts with the stocktake journal

Date: 2026-10-25

Status: Accepted

F-FLD-08 adds field counts for explicitly configured consumables and equipment beside the existing linen section. All three categories use the existing assigned-task authorization, effective `inventory.minimums` resolver, immutable stocktake and movement ledger, audit writer, sync receipt and outbox producers. The server requires the reported and current item category and unit to agree; changing a category never rewrites a materialized item.

The pull batches both sections in one configuration and stock lookup. Each section is an optional projection, so clients that omit inventory retain their existing response and revision. Missing categories remain excluded. Inventory stock changes participate in opted-in cache revisions, and current view-only access disables counting.

The counter component takes a linen or inventory surface and uses the existing durable stocktake journal. The persisted `linenDrafts` table keeps its name and v5 schema for compatibility; its task/item identity already separates every configured count. Successful and conflicted receipts advance only the unique matching section and exact quantity/revision base. An item appearing in both sections is rejected as ambiguous. Older pulls, pending payloads and failed ancestors retain their existing fences.

There is no second queue, balance or count endpoint. Both sections block completion while an unsent draft exists, and unresolved count receipts hold completion without stopping other jobs. Existing logout, account-change and remote-revocation wipes clear the same nine private tables.

Validation uses real PostgreSQL for category provenance, concurrent duplicate delivery, explicit stale-count review, effective agreements, role and tenant denial, and bounded queries across properties. The complete localized browser journey is shared across linen, consumables and equipment, retaining cold offline reload, held-pull conflict review, invalid intermediate typing, immutable failed history, keyboard, axe and overflow assertions.
