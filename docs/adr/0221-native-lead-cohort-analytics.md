# ADR0221 — Original acquisition cohorts and native conversions

Source analytics groups native Lead captures by their original source, channel
and retained multilingual source label. A later profile or source-label
correction does not rename an earlier acquisition. A conversion is an actual
immutable LeadConversion record, rather than a signed stage or a count of
distinct Owners. Several Leads explicitly linked to one Owner remain separate
Lead conversions.

The capture window includes its start and excludes its end. Native conversions
and pipeline positions are observed at the report's displayed PostgreSQL time.
The capture window and observation time are both shown to the reader. Dates
use explicit UTC instants; lossy sub-millisecond requests are rejected.

Use existing tenant repositories, indexes, native history, authorization,
serialization, audit and rate limiting. No new business table, Owner or
agreement model is required. Complete organization analytics requires held and
stored unconditional organization Lead view and export authority, through the
existing organization-source authorization helper. Narrower and conditional
grants cannot be assembled into a misleading complete source. Financial
authority is neither implied nor granted. Owner identities, contacts and money
are absent from the projection.

The approved crm.lead_analytics rule declares the native attribution protocol,
range and source-group limits, retained-label semantics and read budget. It
has no business defaults or automatic activation. Commit the configured read
budget before querying, retaining it when later validation or authority fails.
Excess source groups fail explicitly; never publish a truncated cohort.

PostgreSQL groups complete native records. Counts stay decimal integer strings
and use BigInt during reconciliation and localized display. Every source and
stage total must reconcile; no floating-point rate or financial estimate is
introduced. Source groups paginate in the browser without persisting private
results. Query and policy fingerprints remain internal publication fences;
generic audit facts contain no counts, source labels or contact data.

Recheck native aggregates, active policy and held/current authority after the
canonical read audit and before publication. Responses are private and not
cached. Abort and clear browser results on offline, visibility, account-scope
and navigation changes. Authenticated hosted acceptance remains required.

Scope unchanged: all 355 feature IDs remain required.
