# ADR 0103: Supplier disbursements retain journal and audit sources

Status: Accepted for implementation; F-FIN-23 acceptance remains outstanding.

An approved invoice is recognized once against its original immutable cost allocations. Recording a payment settles that existing supplier claim through the shared Money posting rule, FinanceRepository writer, tenant transaction and audit writer. It creates two movements: debit the supplier claim and credit the selected physical funding account. It does not recognize another expense or execute a transfer through a bank provider.

Payment intent is retained in the journal's immutable attributed audit receipt: original actor, invoice version and recognition, exact amount/currency, actual paid instant, physical funding source, external reference, reason and tenant-scoped retry identity. Journal and receipt commit atomically. A replay requires the same actor and normalized intent after current source and funding authorization; it returns the original journal even if that payment was subsequently reversed.

Settlement and its exact reversal hold the recognition service's invoice lock. The existing wallet-holder and financial-account locks protect funding sources. Whole-invoice source permissions prevent bypassing an authorization threshold by splitting a payment. Caller restrictions are intersected with current stored grants after actual locks, writes and deferred database guards. Balance and history readers independently require the original claim and every contributing payment/reversal source, including original and adjusted dates and funding wallets.

Outstanding money is always derived from actual supplier-claim movements. No editable balance, competing transaction writer, supplier payment table or second audit stream is introduced. Reversal appends an exact opposite through the existing reversal matcher and journal constraints, retaining the original claim, payment and all receipts. An intent mismatch cannot adopt another actor's payment or reversal.

The configured accounting-period engine governs every posting. Historical disbursements in a closed period require independent override permission, an explicit current-period choice and a reason. The immutable payment receipt links the actual closed period and decision while retaining the original paid instant and current posting instant. Database guards validate those links and the current open period. This payment provenance does not change the existing expense/recognition adjustment interface or introduce a legal/accounting convention.

Forward migration 78 enforces canonical receipt attribution, recognized source identity, exact two-movement settlement, physical funding type, positive currency precision, original/current date provenance, append-only reversal attribution and nonnegative remaining claim. The posting trigger shares the invoice lock even for raw journal attempts. Applied SQL is frozen after rollback-only execution of real recognition, payment, replay and reversal against a populated database; correction requires another forward migration.

Native payment controls, recognition reversal, full CI and authenticated staging acceptance remain part of the complete F-FIN-23 delivery. This internal service change does not mark the feature DONE.
