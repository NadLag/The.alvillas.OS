# ADR0206: Configured document classifications and native party sources

F-DOC-08 requires owner contracts, amendments, guest agreements, house rules,
invoices, receipts, property, supplier, staff and report documents. Existing
archive, authored templates, generation, immutable versions and signatures remain
the shared document workflow.

Each authored `documents.archive` type may explicitly select one of these ten
classifications. Keys, translated labels, accepted formats, size limits and source
eligibility remain configuration. Existing types stay unclassified until their
configuration is explicitly changed; no filename, title or key implies a category.
The archive displays the classification from the original policy snapshot, so a
later rule cannot relabel retained history. Invoices and receipts require financial
protection; owner contracts, guest agreements, supplier and staff classifications
require sensitive protection. Native guards retain these protections.

Supplier and guest documents bind real tenant-owned source rows through composite
foreign keys. Source view/export permissions are checked independently of document
permissions and require organization scope, as existing staff and signature-party
access does. Supplier/guest sources always retain sensitive protection; financial
documents additionally retain the existing financial authority checks. Archived
suppliers and archived or merged guests remain readable with authority but cannot
accept new documents or generation. Template values use explicit native names
through the existing repository and binding protocol.

Forward migrations add only nullable source references, checked constraints
and classification guards. New roots must bind their exact immutable tenant
configuration, including its version, full value and eligible source. They do not rewrite existing documents, signatures,
policy snapshots or financial rows. Previously applied migrations remain frozen.
Legal wording, signing level, retention periods and taxes are not selected by this
classification and still require their approved configuration and acceptance.
