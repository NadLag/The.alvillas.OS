# 0074 — Page authorized configuration history

Date: 2026-10-25

Status: Accepted

The administration screen previously selected the first 200 rules before applying authorization. Repeated real PostgreSQL browser fixtures reproduced a successfully created draft disappearing beyond that limit, with no way to reach it. The same implementation could leave a scoped administrator with an empty list when permitted records followed other properties' rules.

Configuration history now fills a page of 50 currently permitted records by scanning bounded candidate batches through the existing repository and `authorize` checks. Exact key and scope filters reduce the candidate set. Cursor boundaries must belong to the current tenant, filter and permitted scope; changed permissions and financial access are rechecked for every request. No total reveals denied records. Property choices use the same current configuration-view authorization.

Forward and backward cursors use a stable, explicitly reversible ordering. Rule values and lifecycle history remain append-only. A batched lateral lookup resolves each displayed rule's actual preceding version, including predecessors outside the page. Previous financial values pass the existing financial-access check before contributing to a diff. Effective-value previews continue to use the shared resolver rather than the displayed page.

The history filter disables property selection unless its property scope is selected. The existing preview form remains separate. Paging does not create or alter business records, permissions, approval decisions or balances.

The configuration form previously generated browser-local defaults but parsed
timezone-free input in the server's local zone. Configuration creation,
activation, retirement and preview now explicitly use UTC, including localized
labels and history display. The shared input schema normalizes timezone-free
form instants; explicit offsets and Date-valued service calls retain their
original instant. Existing effective dates and rule versions are not rewritten.

Three locale contract tests bind workflow-template labels to the canonical task enum. The missing labels reuse established operation translations. Real PostgreSQL cases cover 501 properties, a permitted record beyond 500 denied records, exact reverse navigation, malformed and foreign cursors, cross-page history, financial visibility and bounded query count. Localized browser cases traverse all 230 fixture versions and every canonical workflow task option with keyboard-accessible controls, axe and overflow checks.
