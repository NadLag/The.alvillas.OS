# ADR 0123: Private employee payment review and recovery

Recognized employee claims need a usable payment and wallet-offset workspace while retaining their original source, independent salary and funding permissions, and append-only journals.

The page renders only locale, source identifiers and an actor-scoped recovery key. A same-origin authenticated POST returns the private review model; amount, local time and funding search remain in memory and never enter URLs or browser storage. The read reuses the canonical settlement preparation and reversal checks, derives outstanding money from postings, independently checks funding views and payment grants, and repeats current stored authority before returning data. Own wallets appear only for explicit offsets backed by their actual available advance.

An explicit review converts the local payment time through the configured accounting calendar, including repeated-time selection. The command binds the reviewed calendar ID and version and converts the local time again while holding the existing calendar locks. A changed calendar rejects a new command; an exact existing payment remains recoverable. Closed dates require an explicit authorized current-period adjustment.

The existing compensation command hook accepts synchronous settlement receipts through a typed adapter and recovery schema. Only the random, source-and-actor-scoped nonce survives reloads. Interrupted acknowledgements retain the exact in-memory request for retry; recovery returns the original attributed payment. A fresh settlement requires an explicit new intent. Reversals use the existing immutable payment identity and exact original reason for retry, then refresh actual journal history.

Connection loss clears financial read models and drafts. All UI strings are in English, French and Arabic message files; browser checks exercise real PostgreSQL, actual configured review, native payment/offset/reversal, lost acknowledgement, privacy, access revocation, RTL and mobile width. Existing claim, cost, wallet and supplier flows retain their regression checks. No business table, migration or financial balance field is added.
