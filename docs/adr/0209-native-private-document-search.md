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

Trigram indexes are evaluated against measured native 500-property queries before
any forward migration is applied. Existing financial/document tuples and frozen
migrations remain untouched. Encrypted PDF or template bodies are not copied into
a second unencrypted search store. Hosted private-storage acceptance remains part
of the module's Definition of Done.
