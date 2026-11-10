# ADR 0230 — Current authority at canonical role assignment

Native Team admission must reuse the existing Team and Identity role writers. Actual PostgreSQL regressions exposed stale stored grants being accepted, temporary source permission conditions becoming unconditional delegation, a Person identity being reused as an unrelated permission resource identity, and valid geographic or Role-specific caps being denied. Original failing diagnostics remain retained separately from corrected fixture receipt/date assumptions.

The existing grant ceiling now requires an unconditional source grant for every delegated permission at the actual assignment scope, or the explicit existing `role:override` capability. A Role identity applies to assigning or overriding that Role; it cannot act as the identity of every resource the Role can access. This preserves the existing distinction between an administrative grant action and access to underlying data.

Both canonical assignment writers intersect the held authorization cap with current stored authority before writing and after the attributed audit. Late grant, scope, selected account, Person or Role-permission changes reject the transaction. Team scope metadata comes from tenant-scoped canonical rows, including the actual Property's city and region. The Team writer reads only the Person/account/assignment metadata needed for this command.

Existing `authorize`, current-account loading and grant-ceiling helpers remain authoritative. There is no additional authorization engine, role model, financial permission, compensation inference, migration or historical financial rewrite. The explicit null-account behavior remains unchanged.

Fourteen actual canonical regressions now pass with the qualified red assertions unchanged, as do the 26 existing Team cases with real stored operational fixture delegation. Full regression, browser, exact-head CI and hosted acceptance remain release requirements. The existing 225 migrations stay immutable, and native TEAM remains closed until its separate source, admission, history, database, API and UI acceptance is complete.
