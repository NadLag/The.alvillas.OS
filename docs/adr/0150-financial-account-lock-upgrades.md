# ADR 0150: Acquire posting account locks without upgrades

Date: 2026-11-02

Status: Accepted

Four actual receipts against independent original claims can share their receipt bank and ownership account. The existing account repository acquired `FOR SHARE` before receipt policy locks. The original wallet/offboarding posting trigger then required `FOR UPDATE` on those same accounts. A waiting command retained its shared account locks while another command held the policy lock and waited for that account upgrade. PostgreSQL reported a deadlock for both receipts and exact opposite corrections.

The existing `FinancialTransferRepository.lockAccounts` now acquires `FOR UPDATE` immediately, in its existing sorted and deduplicated account order. Callers retain wallet-holder, calendar, original-source, policy, fresh authorization and financial guard checks. This strengthens the existing account fence and agrees with the strongest mode already required by posting birth. No alternate lock helper, retry, financial rewrite or SQL migration is introduced.

Commands using the same accounts serialize before their policy and source work. Independent account sets remain independent. Real PostgreSQL regressions run four distinct original-claim receipts concurrently and then four independent exact opposite corrections. Every receipt must commit once, every correction must restore its original net amount, and original journal and posting values and row versions must remain intact. The retained pre-repair run fails both cases with PostgreSQL `40P01`.

The diagnosis follows PostgreSQL's documented requirement to acquire locks consistently and begin with the strongest required mode: https://www.postgresql.org/docs/17/explicit-locking.html#LOCKING-DEADLOCKS.
