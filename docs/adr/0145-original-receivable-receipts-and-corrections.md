# ADR 0145: Actual receipts against original receivable claims

Date: 2026-11-02

An assigned receivable identifies the original posted ownership debit and its explicitly selected debtor. Recording money received must preserve that identity and distinguish the ownership claim from the account that actually received the funds.

Each receipt therefore adds one immutable tenant-scoped record and one balanced, sealed journal. It debits the explicitly selected, configured money location and credits the original claim account. Its amount cannot exceed the assigned amount less actual original and opposite posting movements. Neither outstanding amounts nor account balances are stored. The receipt retains the complete original source, effective configuration, authorization cap, actor, reason and idempotent command identity. The assignment cannot be released, and its original source cannot be reversed, while actual collected movements remain outstanding.

A correction adds an immutable typed record and the exact opposite of the original receipt journal in the current open period selected by the explicit accounting policy. The original receipt, journal, postings and attributed audit remain unchanged. Any replacement requires a new review and command. PostgreSQL locks the original intent, journals and source consistently; deferred guards require matching financial history, same-birth audit and outbox event. The command key identifies exactly one assignment, release, receipt or correction.

Company financial read authority and independently protected staff compensation authority remain prerequisites. Actual destination wallet access is checked separately for mutations, private reads, recovery and history. Held restrictions intersect freshly loaded grants before writes and at the response boundary. History resolves original scope references in bounded batches, returns only independently authorized records and binds encrypted cursors to the tenant, actor and assignment filter. Only the random command nonce survives a browser reload; private financial details remain in memory and clear on connection loss or denied access.

Methods, translated labels, destination codes, receipt bucket and date treatments belong to versioned configuration. The application does not infer a new debtor from a current guest, invent payment terms or perform an external provider charge when recording an actual receipt. Money calculations and opposite journals use the shared exact `Money` implementation.
