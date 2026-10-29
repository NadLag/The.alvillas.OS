# 0096 — Actual supplier invoice events in organization automations

Supplier invoice submission and review events refer to one immutable revision and
may span both company and property costs. Picking one villa for their automation
scope would misrepresent the source and could apply an unrelated property rule.

These events use the existing automation engine with an organization scope and a
nullable run property. Migration 75 adds a partial unique index for organization
outcomes and validates the actual tenant, immutable submission, canonical event,
organization rule and rule principal. Property runs keep their existing checks.
No sentinel property, synthetic expense, parallel approval or financial movement
is created. A configured approval action references the submission's real shared
approval; it fails when the frozen policy required none. Operational actions that
need a property require a real property context.

The source adapter derives fields from the actual frozen invoice revision. Its
event date is the immutable economic date; event occurred_at remains the recorded
event timestamp. Submitted and requested states remain frozen when a later review
or replacement draft changes the current header. Current source state still
protects access. The existing event consumer registers SupplierInvoiceSubmitted.

The shared finance authorization helper preserves caller restrictions and checks
current stored grants at the database clock. It protects complete supplier and
invoice access, each actual allocation's financial and reservation sources, and
organization configuration rights. Finance configuration references additionally
require an organization financial source grant. Checks precede keys, frozen
inputs, predicates (including false outcomes), previews and actions, and repeat
after action, run, attempt and audit writes. A denied admission stores only event,
rule and version references and a failure code. History masks private fields and
source selection omits inaccessible invoices. Completed predicate status, attempts,
completion metadata and event references are omitted when source authority is
unavailable; the UI displays a localized restricted outcome. Replay checks the requesting actor
independently of the stored execution principal.

Replay resolves the original rule's configuration references before returning
even a completed outcome, preserving independent organization finance access for
configuration predicates. Native EN/FR/AR validation also checks 200% text and
RTL layouts; scoped controls shrink and action labels wrap within their panels.

Canonical invoice business event facts cannot be edited or deleted. Submission
requires its canonical outbox event atomically, complementing the existing deferred
source, review, notice and audit assertions. Worker delivery metadata can advance.
All 74 prior applied migration files and all historical financial rows are retained.
