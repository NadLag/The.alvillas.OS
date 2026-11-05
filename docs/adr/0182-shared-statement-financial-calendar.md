# 0182 — Shared statement financial calendar

Status: Accepted

F-FIN-42 requires the owner portal and statement PDFs to use the same period, opening balance, bucket movements and closing balance. UTC-only portal boundaries and profile-only export boundaries could classify the same original posting into different periods.

The shared ledger calendar repository resolves the effective organization `finance.accounting_periods` timezone, with the explicitly configured organization profile timezone as its existing fallback. Missing configuration fails closed. Civil dates use the pinned runtime timezone database and become inclusive-start, exclusive-end instants. The portal accepts registered currencies independently and retains exact Money calculations through the existing canonical statement builder. Its statement audit records carry the calendar policy, selected currency, civil dates and a versioned hash; historical audit records remain unchanged.

The accountant export pipeline uses the same calendar. Its existing admission and final source fences include the resolved calendar policy identity and timezone, so a concurrent calendar change withholds rendered bytes and the success audit. Original financial rows remain append-only. Real CSV and EN/FR PDF acceptance compares source movement identities and exact opening, credits, debits and closing against the portal. Arabic document text uses message catalogs and the existing Arabic-capable renderer interface.

The owner UI uses labeled date and currency filters, preserves the complete selection when changing locale, and identifies invalid input while showing configured month defaults. Native owner relationships continue to determine portal access; independent full financial export authority remains required for accountant exports.
