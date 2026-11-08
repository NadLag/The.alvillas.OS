# ADR0217 — Native lead document source

Proposal generation must use the actual acquisition record before an owner or
property has been created. A caller supplies native references and an approved
template selection. Document values come from the retained capture or its latest
immutable profile correction.

Register `LEAD` in the existing document source contract. A nullable `lead_id`
column and composite organization/lead foreign key retain native ownership.
Extend the source-shape constraint in a forward migration and require sensitive
privacy for every lead document. Existing source relations, financial rows,
policy snapshots and applied migrations remain intact, without a data backfill.

The platform layer composes existing lead repositories with the document
infrastructure. The source includes current stage, profile and representative
positions, the original capture hash and current approved capture configuration.
The document boundary requires independent held/current lead and document
authority. Export and generation use the existing export and instance checks.
Representative assignment grants no access.

Fixed bindings provide actual contact and property assessment fields, native
integer values and the selected language's retained catalog labels. Private
notes, referral identities and financial amounts are excluded. Missing values
and unknown bindings fail closed. Approved EN/FR template variants and any
approved Arabic variant retain their explicit language contracts.

Reuse existing generation review, durable admission, encrypted render input,
PDF production, versioning, effective history, audit and outbox infrastructure.
Source positions and fingerprints are checked again at admission and production.
Proposal stage evidence must reference an actual effective PDF instance for the
same organization and lead, with the configured proposal type. Signature and
conversion evidence continue through their native producers. Registering the
lead archive source keeps lead signing closed until F-CRM-06 supplies native
recipient identity and its required provider evidence.

Scope unchanged: all 355 features remain required.
