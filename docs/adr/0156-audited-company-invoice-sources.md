# Audited company invoice sources

Company plans estimate costs. An actual company invoice is a separate canonical source with its own approval, recognition, payment and reversal history. Linking a plan cannot create or rewrite that invoice or any journal.

An append-only association stream binds one actual recognized company-only invoice line to an immutable plan version. Source versions serialize concurrent changes; exact replay returns the existing receipt. Release and reassignment append history. Tenant foreign keys, forced RLS, native source guards and deferred audit checks protect the association. Salary-source classification cannot be downgraded through release or reassignment.

The service reuses the canonical invoice settlement inspector and invoice lock, independent held/current financial grants and final revocation checks. The page retains native source, currency and journal identities. Payment totals and history come directly from the canonical invoice settlement service and are explicitly scoped to the whole invoice. No proportional payment allocation to a cost line is invented. A real partial payment and its exact opposite remain original journal movements.

The company plan keeps its estimate; the invoice retains its actual amount. The two values remain distinct. Supplier-invoice access and payroll access remain independent from company-plan access. Actual employee compensation source links, the localized company workspace and authenticated financial staging acceptance remain required before F-FIN-27 can be DONE.
