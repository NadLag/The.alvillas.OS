# ADR 0166: Retained bank sources and resumable admission

Date: 2026-11-03

Status: Accepted

Bank statements provide independent evidence of movements at an actual bank account. Financial movements continue through the existing ledger and its authorized commands. Statement ingestion retains evidence that those commands can later be reconciled against.

The original bytes are retained in private R2 through the existing StorageProvider. The server bounds the request, applies the explicit configured encoding and mapping, verifies the original SHA-256, and reads back the stored object before committing the normalized evidence. Storage transport occurs outside database transactions. Object keys bind the tenant, admitted request and original digest; signed transport URLs stay on the server.

Admission retains the original actor, random nonce, complete command input, review fingerprint and policy snapshot. PostgreSQL independently binds the command fingerprint and atomic admission audit. Recovery reads that immutable intent, allowing the same original file to complete an interrupted upload. Current and captured financial authority are checked at admission, after storage transport and after the final audit. Source history remains readable under independent view authority after import authority ends.

Canonical source movements are separate from occurrences in imported files. OFX FITIDs are scoped to the actual financial institution and account. Configured CSV transaction IDs use the same account scope; ordinary payment references remain reference text. CSV records without transaction IDs retain their original file digest and row order, including identical legitimate movements. Repeated imports associate their evidence with the original canonical rows. Review and acknowledgements derive counts of new and previously retained movements from those immutable associations.

OFX replacement and removal instructions retain their original target identifiers as new source evidence. Original facts remain unchanged, and correction chains must be acyclic. Pending OFX transactions remain separate from posted source movements. The format semantics follow the [FDX OFX banking specification](https://financialdataexchange.org/wp-content/uploads/2025/12/OFX-Banking-Specification-v2.3.pdf). Each admitted file belongs to one actual bank account; multi-account exports are rejected at the admission boundary.

Dates, decimal separators, grouping, amount precision, file limits and matching rules come from explicit configuration. Original source precision is validated before Money construction. The existing CSV parser retains its default validation and limits; bank ingestion explicitly accounts for the header row and supports an original export containing no movements.

All source tables use tenant-composite references, forced row-level security, immutable rows and atomic audits. Canonical source amounts retain a currency-catalog reference. Historical account discovery uses the retained admissions, independently of current import configuration and account retirement. File bytes, source facts and financial intent stay outside browser persistence; only the scoped nonce survives reloads. Private views clear on offline transitions and revoked authority.

Applied SQL remains immutable. Subsequent guard corrections and history indexes use additive migrations, preserving diagnostic evidence and earlier source admissions.
