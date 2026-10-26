# Transaction group membership preserves posted journals

F-FIN-04 and master specification section 26 require transaction groups. The existing journal is balanced and sealed at commit; grouping a historical transaction cannot update its header or postings.

Groups and membership entries are tenant-bound metadata. A transaction has one current membership chain. Attaching, detaching and moving append a reasoned successor; predecessors and original acknowledgements remain valid history. Tenant foreign keys, unique roots and successors, transaction advisory locks, append-only triggers and deferred audit checks enforce this in PostgreSQL. Request keys and expected predecessor IDs provide safe retries and stale-write detection.

Group administration reuses current organization-wide financial view and configure grants. The audit presenter requires independent financial visibility and export permissions for group payloads. Operational, property-scoped and amount-capped grants do not confer access to the collection.

Net movements are derived from every currently linked posting through the existing Money type, separately by account and currency. Location, ownership and company accounts remain distinct. Pagination never determines a total. History cursors compare retained timestamps inside PostgreSQL to preserve microseconds.

No existing journal, posting, balance, agreement or audit row is rewritten. Grouping creates no payment or financial posting. Native acceptance extends the existing expense approval/payment/reversal journeys and retains their original assertions.
