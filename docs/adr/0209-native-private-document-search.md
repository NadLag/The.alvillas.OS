# ADR0209: Authorized native document metadata search

F-DOC-11 searches the archive's original version titles and file names in
PostgreSQL, as required by the locked specification's search decision. It covers
configured document categories, native source references, language variants,
templates, generated instances, signed artifacts and retained versions. Explicit
filters distinguish the current effective version, historical/scheduled versions
and archived sources. Search terms are literal; percent and underscore characters
do not expand them into user-supplied SQL patterns.

Every published match must pass the existing archive's current and held document,
source, template, counterparty and financial checks, including signed-artifact
provenance. Tenant predicates and coarse necessary permission filters narrow
candidates; they do not grant access. Publication rechecks source facts and
authority after the private read audit. Results expose authorized metadata and an
opaque continuation, without raw match counts, hidden facets or object URLs.
Opening a version uses the existing private archive/download flow.

The implementation uses existing repositories, authorize/present, actor context,
authenticated HTTP, encryption, audit and localized private browser controls.
Queries and cursors are bounded and actor/filter restricted. Private query text,
titles and file names are omitted from audit payloads and telemetry; audit records
contain fingerprints and authorized result identities/counts only.

Each bounded read phase batches version metadata, native source facts and archive
rules through the existing repositories. A new phase loads actual grants and
source facts after the audit; final publication still checks current authority.
Prepared financial reads preserve the ordinary repository's Money calculations,
source fingerprints and inherited checks. Ambiguous legacy find-first relations
retain their original lookup. Commands never borrow these read snapshots.

The 501-property native case traverses all 500 property originals, verifies held
property scopes and unchanged original financial/document tuples, and prevents
query growth between one result and a twenty-result page. Measured warm p95 was
199 ms at 100 properties and 234 ms at 500, with 36 queries. Distinct financial
sources use 64 queries for either page size; the measured twenty-result page fell
from 1,861 ms and 664 queries to 279 ms and 64 queries.

Candidate title/file-name trigram indexes were tested under the actual non-owner
tenant role and rolled back. Their median query improvement was under 1 ms on the
501-property fixture, so no forward migration is justified. Original tuples,
indexes, extensions and all 207 migration records were verified unchanged.
Encrypted PDF or template bodies are not copied into a second unencrypted search
store. Hosted private-storage acceptance remains part of the module's Definition
of Done.
